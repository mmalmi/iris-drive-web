import { test, expect } from './fixtures';
import { spawn, type ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { acquireRustLock, releaseRustLock } from './rust-lock.js';
import { HASHTREE_RUST_DIR, rustTargetPath, withRustTargetEnv } from './rust-target.js';
import {
  HTTP_URL,
  RUST_SERVER_PORT,
  RUST_SERVER_URL,
  MsgpackWsClient,
  ServingWsClient,
  TestWsClient,
} from './ws-interop.helpers';

test.describe('rust WebSocket Integration', () => {
  // Serial mode: shares rust server process via beforeAll/afterAll
  test.describe.configure({ mode: 'serial', timeout: 300000 });
  test.setTimeout(300000);

  let rustProcess: ChildProcess | null = null;
  let tempDir: string | null = null;
  let configDir: string | null = null;
  let lockFd: number | null = null;

  test.beforeAll(async () => {
    test.setTimeout(300000);
    // Check if rust binary exists (skip tests if not built)
    const rustWorkspaceDir = HASHTREE_RUST_DIR;
    const rustBinaryPath = rustTargetPath('release', 'htree');
    try {
      execSync(`cargo metadata --manifest-path ${path.resolve(rustWorkspaceDir, 'Cargo.toml')}`, { stdio: 'ignore' });
    } catch {
      console.log('rust not available, skipping ws-interop tests');
      test.skip();
      return;
    }

    lockFd = await acquireRustLock(240000);

    // Create temp directory for Rust server storage
    tempDir = execSync('mktemp -d').toString().trim();
    console.log('Temp directory:', tempDir);

    // Create isolated config dir with auth disabled
    configDir = execSync('mktemp -d').toString().trim();
    const configPath = path.join(configDir, 'config.toml');
    const relayUrl = process.env.VITE_TEST_RELAY || 'ws://localhost:4736';
    fs.writeFileSync(configPath, [
      '[server]',
      'enable_auth = false',
      'enable_webrtc = false',
      'stun_port = 0',
      '',
      '[nostr]',
      `relays = ["${relayUrl}"]`,
      'crawl_depth = 0',
      '',
    ].join('\n'), 'utf8');

    console.log('Building rust server binary...');
    execSync('cargo build -p hashtree-cli --release --bin htree', {
      cwd: rustWorkspaceDir,
      env: withRustTargetEnv({ ...process.env, CARGO_TERM_COLOR: 'never' }),
      stdio: 'ignore',
    });

    // Start rust server from the prebuilt binary so startup isn't blocked on compilation.
    console.log('Starting rust server...');
    rustProcess = spawn(
      rustBinaryPath,
      ['start', '--addr', `127.0.0.1:${RUST_SERVER_PORT}`, '--data-dir', tempDir],
      {
        cwd: rustWorkspaceDir,
        env: { ...process.env, RUST_LOG: 'hashtree_cli=debug', HTREE_CONFIG_DIR: configDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    // Log output
    rustProcess.stdout?.on('data', (data) => {
      console.log('[rust stdout]', data.toString().trim());
    });
    rustProcess.stderr?.on('data', (data) => {
      console.log('[rust stderr]', data.toString().trim());
    });

    // Wait for server to start (longer timeout for initial compilation)
    let serverReady = false;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const response = await fetch(`${HTTP_URL}/api/stats`);
        if (response.ok) {
          serverReady = true;
          console.log('rust server is ready');
          break;
        }
      } catch {
        // Server not ready yet
      }
    }

    if (!serverReady) {
      throw new Error('rust server failed to start within 120 seconds');
    }
  });

  test.afterAll(async () => {
    if (rustProcess) {
      rustProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      rustProcess.kill('SIGKILL');
    }
    if (lockFd !== null) {
      releaseRustLock(lockFd);
      lockFd = null;
    }
    if (tempDir) {
      try {
        execSync(`rm -rf "${tempDir}"`);
      } catch {
        // Ignore cleanup errors
      }
    }
    if (configDir) {
      try {
        execSync(`rm -rf "${configDir}"`);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test('TypeScript WebSocketPeer can connect to rust /ws', async () => {
    const client = new TestWsClient();
    const connected = await client.connect(RUST_SERVER_URL);
    expect(connected).toBe(true);
    client.close();
  });

  test('receives not-found response for missing content via WebSocket protocol', async () => {
    // This test verifies that the protocol works correctly:
    // - Client can send JSON request with { type: 'req', id, hash }
    // - Server responds with { type: 'res', id, hash, found: false } for missing content

    const client = new TestWsClient();
    const connected = await client.connect(RUST_SERVER_URL);
    expect(connected).toBe(true);

    // Request a hash that doesn't exist
    const nonExistentHash = 'deadbeef'.repeat(8); // 64 char hex
    console.log('Requesting non-existent hash:', nonExistentHash.slice(0, 16));

    const data = await client.request(nonExistentHash, 2000);
    // Should return null (not found) - this verifies the protocol is working
    expect(data).toBeNull();

    client.close();
  });

  test('can send multiple requests in sequence', async () => {
    // Verify the protocol handles multiple sequential requests correctly
    const client = new TestWsClient();
    const connected = await client.connect(RUST_SERVER_URL);
    expect(connected).toBe(true);

    // Send multiple requests - all should get "not found" responses
    const hashes = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ];

    for (const hash of hashes) {
      const data = await client.request(hash, 2000);
      expect(data).toBeNull(); // All should be not found
    }

    client.close();
  });

  test('JSON protocol format is correct', async () => {
    // Verify the JSON message format works correctly
    const ws = new WebSocket(RUST_SERVER_URL);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Failed to connect'));
      setTimeout(() => reject(new Error('Connection timeout')), 5000);
    });

    // Send a request and verify we get a properly formatted response
    const responsePromise = new Promise<{ type: string; id: number; hash: string; found: boolean }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Response timeout')), 5000);

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          clearTimeout(timeout);
          resolve(JSON.parse(event.data));
        }
      };
    });

    // Send request with specific ID
    const requestId = 123;
    const testHash = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    ws.send(JSON.stringify({ type: 'req', id: requestId, hash: testHash }));

    const response = await responsePromise;
    ws.close();

    // Verify response format matches protocol spec
    expect(response.type).toBe('res');
    expect(response.id).toBe(requestId);
    expect(response.hash).toBe(testHash);
    expect(response.found).toBe(false);
  });

  test('msgpack WebRTC-style protocol works over /ws', async () => {
    const serving = new ServingWsClient('ServingClient');
    const servingConnected = await serving.connect(RUST_SERVER_URL);
    expect(servingConnected).toBe(true);

    const payload = new TextEncoder().encode('Hello from msgpack client');
    const hash = serving.addData(payload);

    const client = new MsgpackWsClient();
    const connected = await client.connect(RUST_SERVER_URL);
    expect(connected).toBe(true);

    const received = await client.request(hash, 5000);
    expect(received).not.toBeNull();
    expect(Buffer.from(received!).toString('hex')).toBe(Buffer.from(payload).toString('hex'));

    client.close();
    serving.close();
  });

  test('WebSocket relay: Browser B gets file from Browser A via Rust server', async () => {
    // This test verifies end-to-end peer-to-peer relay through the server:
    // 1. Browser A (ServingWsClient) connects and has some data
    // 2. Browser B (TestWsClient) connects and requests that data
    // 3. Server forwards request to A, gets response, relays to B
    // 4. B receives the data successfully

    // Browser A: has content to serve
    const browserA = new ServingWsClient('BrowserA');
    const connectedA = await browserA.connect(RUST_SERVER_URL);
    expect(connectedA).toBe(true);

    // Add some test data to Browser A
    const testContent = new TextEncoder().encode('Hello from Browser A! This is test content for relay.');
    const contentHash = browserA.addData(testContent);
    console.log('Test content hash:', contentHash);

    // Give server time to register Browser A
    await new Promise(r => setTimeout(r, 100));

    // Browser B: wants to get the content
    const browserB = new TestWsClient('BrowserB');
    const connectedB = await browserB.connect(RUST_SERVER_URL);
    expect(connectedB).toBe(true);

    // Browser B requests the data (which only Browser A has)
    // Server should forward to A, get response, and relay to B
    console.log('Browser B requesting data from Browser A via server relay...');
    const receivedData = await browserB.request(contentHash, 5000);

    // Verify B received the correct data
    expect(receivedData).not.toBeNull();
    if (receivedData) {
      const receivedText = new TextDecoder().decode(receivedData);
      console.log('Browser B received:', receivedText);
      expect(receivedText).toBe('Hello from Browser A! This is test content for relay.');
    }

    // Clean up
    browserA.close();
    browserB.close();
  });

  test('WebSocket relay: Multiple browsers can serve different content', async () => {
    // Test with 3 browsers: A has file1, B has file2, C requests both

    // Browser A
    const browserA = new ServingWsClient('BrowserA');
    await browserA.connect(RUST_SERVER_URL);
    const file1 = new TextEncoder().encode('File 1 content from A');
    const hash1 = browserA.addData(file1);

    // Browser B
    const browserB = new ServingWsClient('BrowserB');
    await browserB.connect(RUST_SERVER_URL);
    const file2 = new TextEncoder().encode('File 2 content from B');
    const hash2 = browserB.addData(file2);

    await new Promise(r => setTimeout(r, 100));

    // Browser C requests both files
    const browserC = new TestWsClient('BrowserC');
    await browserC.connect(RUST_SERVER_URL);

    // Request file 1 (from A)
    const received1 = await browserC.request(hash1, 5000);
    expect(received1).not.toBeNull();
    expect(new TextDecoder().decode(received1!)).toBe('File 1 content from A');

    // Request file 2 (from B)
    const received2 = await browserC.request(hash2, 5000);
    expect(received2).not.toBeNull();
    expect(new TextDecoder().decode(received2!)).toBe('File 2 content from B');

    // Clean up
    browserA.close();
    browserB.close();
    browserC.close();
  });
});
