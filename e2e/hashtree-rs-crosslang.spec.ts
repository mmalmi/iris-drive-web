/**
 * Cross-language E2E test: ts (browser) <-> rust
 *
 * Runs a rust WebRTC manager in background and verifies that
 * ts running in a browser can discover and connect to it.
 */

import { test, expect } from './fixtures';
import { getCrosslangPort } from './test-utils';
import WebSocket from 'ws';
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, type Event, nip44 } from 'nostr-tools';
import { spawn, execSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { acquireRustLock, releaseRustLock } from './rust-lock.js';
import { HASHTREE_RUST_DIR, rustTargetPath, withRustTargetEnv } from './rust-target.js';

// Polyfill WebSocket for Node.js
(globalThis as any).WebSocket = WebSocket;

const WEBRTC_KIND = 25050;
const HELLO_TAG = 'hello';
const HASHTREE_RS_DIR = HASHTREE_RUST_DIR;
const tsSecretKey = generateSecretKey();
const tsPubkey = getPublicKey(tsSecretKey);
const hashtreeRsAvailable = (() => {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
  } catch {
    return false;
  }
  return fs.existsSync(path.join(HASHTREE_RS_DIR, 'Cargo.toml'));
})();

function ensureHtreeBinary(): void {
  const debugBin = rustTargetPath('debug', 'htree');
  const releaseBin = rustTargetPath('release', 'htree');

  if (fs.existsSync(debugBin) || fs.existsSync(releaseBin)) {
    return;
  }

  console.log('Building htree binary for rust tests...');
  execSync('cargo build --bin htree --features p2p', {
    cwd: HASHTREE_RS_DIR,
    env: withRustTargetEnv(),
    stdio: 'inherit',
  });

  if (!fs.existsSync(debugBin) && !fs.existsSync(releaseBin)) {
    throw new Error('htree binary build completed, but binary not found');
  }
}

function withRelayNamespace(baseUrl: string, namespace: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/${namespace}`;
}

async function killProcessesOnPort(port: number): Promise<void> {
  const killBySignal = (signal: 'TERM' | 'KILL') => {
    try {
      execSync(
        `for pid in $(lsof -ti tcp:${port}); do kill -s ${signal} "$pid" 2>/dev/null || true; done`,
        { stdio: 'ignore', shell: '/bin/bash' }
      );
    } catch {
      // lsof exits non-zero when nothing is listening.
    }
  };

  killBySignal('TERM');
  await new Promise(resolve => setTimeout(resolve, 300));
  killBySignal('KILL');
}

async function stopProcess(proc: ChildProcess | null, graceMs = 4000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;

  const exited = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
  });

  proc.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
  ]);

  if (proc.exitCode === null) {
    proc.kill('SIGKILL');
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

async function publishWithRetry(
  pool: SimplePool,
  relayUrl: string,
  event: Event,
  attempts = 5
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const relay = await pool.ensureRelay(relayUrl);
      relay.connectionTimeout = 15000;
      relay.publishTimeout = 15000;
      await relay.connect();
      await Promise.any(pool.publish([relayUrl], event));
      return true;
    } catch (err) {
      lastError = err;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  console.log('Publish failed:', lastError);
  return false;
}

function unwrapGiftContent(
  secretKey: Uint8Array,
  ephemeralPubkey: string,
  ciphertext: string
): { content: string; senderPubkey: string } | null {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(secretKey, ephemeralPubkey);
    const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
    const seal = JSON.parse(plaintext) as { content?: string; pubkey?: string };
    if (typeof seal.content !== 'string') return null;
    const senderPubkey = typeof seal.pubkey === 'string' ? seal.pubkey : ephemeralPubkey;
    return { content: seal.content, senderPubkey };
  } catch {
    return null;
  }
}

test.describe('rust Cross-Language', () => {
  test.setTimeout(360000);
  test.describe.configure({ mode: 'serial', timeout: 360000 });
  test.skip(!hashtreeRsAvailable, 'rust toolchain or Rust toolchain not available');
  const rustStartupTimeoutMs = 180000;

  let rsPeerProcess: ChildProcess | null = null;
  let rsPeerPubkey: string | null = null;
  let lockFd: number | null = null;
  const outputLines: string[] = [];
  let localRelay = '';
  let crosslangPort = 0;
  let rsReady = false;

  test.beforeAll(async ({ relayUrl }, testInfo) => {
    testInfo.setTimeout(360000);
    // Start rust crosslang test in background
    console.log('Starting rust peer...');
    crosslangPort = getCrosslangPort(testInfo.workerIndex);
    localRelay = withRelayNamespace(
      relayUrl,
      `hashtree-rs-crosslang-${testInfo.workerIndex}-${crosslangPort}`
    );
    await killProcessesOnPort(crosslangPort);
    lockFd = await acquireRustLock(240000);
    try {
      ensureHtreeBinary();
      rsPeerProcess = spawn(
        'cargo',
        [
          'test',
          '--package',
          'hashtree-cli',
          '--features',
          'p2p',
          '--test',
          'crosslang_peer',
          '--',
          '--nocapture',
          '--ignored',
          '--test-threads=1',
        ],
        {
          cwd: HASHTREE_RS_DIR,
          env: withRustTargetEnv({
            ...process.env,
            RUST_LOG: 'warn',
            LOCAL_RELAY: localRelay,
            CROSSLANG_FOLLOW_PUBKEY: tsPubkey,
            CROSSLANG_PORT: String(crosslangPort),
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (err) {
      if (lockFd !== null) {
        releaseRustLock(lockFd);
        lockFd = null;
      }
      throw err;
    }

    // Capture rust pubkey and ready marker
    const pubkeyPromise = new Promise<string>((resolve, reject) => {
      const handler = (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            outputLines.push(line.trim());
            if (outputLines.length > 200) outputLines.shift();
          }
          const match = line.match(/CROSSLANG_PUBKEY:([a-f0-9]{64})/);
          if (match) {
            resolve(match[1]);
          }
          if (line.includes('CROSSLANG_READY')) {
            rsReady = true;
          }
        }
      };
      rsPeerProcess!.stdout?.on('data', handler);
      rsPeerProcess!.stderr?.on('data', handler);

      rsPeerProcess!.on('exit', (code, signal) => {
        reject(new Error(`rust exited before ready (code=${code}, signal=${signal}). Recent output:\n${outputLines.join('\n')}`));
      });
    });

    // Wait for pubkey with timeout
    rsPeerPubkey = await Promise.race([
      pubkeyPromise,
      new Promise<string>((_, reject) => setTimeout(
        () => reject(new Error(`Timeout waiting for rust pubkey. Recent output:\n${outputLines.join('\n')}`)),
        rustStartupTimeoutMs,
      ))
    ]).catch(() => null);

    if (rsPeerPubkey) {
      console.log(`rust pubkey: ${rsPeerPubkey.slice(0, 16)}...`);
    } else {
      console.log('Warning: Could not capture rust pubkey');
    }

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (rsReady) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - start > rustStartupTimeoutMs) {
            clearInterval(interval);
            reject(new Error(`Timeout waiting for rust ready. Recent output:\n${outputLines.join('\n')}`));
          }
        }, 500);
      }),
      new Promise<void>((_, reject) => {
        rsPeerProcess!.once('exit', (code, signal) => {
          reject(new Error(`rust exited before ready (code=${code}, signal=${signal}). Recent output:\n${outputLines.join('\n')}`));
        });
      }),
    ]);
  });

  test.afterAll(async () => {
    if (rsPeerProcess) {
      await stopProcess(rsPeerProcess);
      rsPeerProcess = null;
    }
    if (crosslangPort > 0) {
      await killProcessesOnPort(crosslangPort);
    }
    if (lockFd !== null) {
      releaseRustLock(lockFd);
      lockFd = null;
    }
  });

  test('ts discovers rust peer via relay', async () => {
    if (!rsPeerPubkey) {
      throw new Error('rust pubkey not captured');
    }

    const pool = new SimplePool();

    // Generate keys for TypeScript peer
    const tsSk = tsSecretKey;
    const tsPk = tsPubkey;

    console.log('TypeScript peer pubkey:', tsPk.slice(0, 16) + '...');

    const discoveredPeers = new Map<string, any>();
    let foundRsPeer = false;
    let receivedOfferFromRsPeer = false;

    const since = Math.floor(Date.now() / 1000) - 60;
    const sub = pool.subscribe(
      [localRelay],
      [
        {
          kinds: [WEBRTC_KIND],
          '#l': [HELLO_TAG],
          since,
        },
        {
          kinds: [WEBRTC_KIND],
          '#p': [tsPk],
          since,
        },
      ],
      {
        onevent(event: Event) {
          if (event.pubkey === tsPk) return;

          const isHello = event.tags.some((t) => t[0] === 'l' && t[1] === HELLO_TAG);
          if (isHello) {
            const peerIdTag = event.tags.find((t) => t[0] === 'peerId');
            const peerId = peerIdTag?.[1];
            if (!peerId) return;

            if (!discoveredPeers.has(event.pubkey)) {
              discoveredPeers.set(event.pubkey, { peerId });
              console.log(`Discovered: ${event.pubkey.slice(0, 16)}... peerId=${peerId.slice(0, 12)}`);

              if (rsPeerPubkey && event.pubkey === rsPeerPubkey) {
                foundRsPeer = true;
                console.log(`*** FOUND HASHTREE-RS PEER! peerId=${peerId} ***`);
              }
            }
            return;
          }

          try {
            let content = event.content;
            if (!content) return;

            let senderPubkey = event.pubkey;
            if (!content.startsWith('{')) {
              const unwrapped = unwrapGiftContent(tsSk, event.pubkey, content);
              if (!unwrapped) {
                return;
              }
              content = unwrapped.content;
              senderPubkey = unwrapped.senderPubkey;
            }

            const msg = JSON.parse(content);

            if (msg.type === 'offer') {
              if (typeof msg.targetPeerId !== 'string' || 'recipient' in msg) {
                throw new Error(`unexpected rust signaling shape: ${content}`);
              }
              if (msg.targetPeerId === tsPk) {
                console.log(`Received OFFER from ${senderPubkey.slice(0, 16)}...`);
                if (rsPeerPubkey && senderPubkey === rsPeerPubkey) {
                  receivedOfferFromRsPeer = true;
                  console.log('*** RECEIVED OFFER FROM HASHTREE-RS! ***');
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        },
      }
    );

    await new Promise(r => setTimeout(r, 1000));

    // Send hellos and wait for discovery
    for (let i = 0; i < 15; i++) {
      const expiration = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);
      const helloEvent = finalizeEvent({
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['l', HELLO_TAG],
          ['peerId', tsPk],
          ['expiration', expiration.toString()],
        ],
        content: '',
      }, tsSk);

      await publishWithRetry(pool, localRelay, helloEvent);
      await new Promise(r => setTimeout(r, 2000));

      console.log(`Check ${i + 1}: Discovered ${discoveredPeers.size} peers, foundRsPeer=${foundRsPeer}`);

      // Success if we found rust or received an offer from it
      if (foundRsPeer || receivedOfferFromRsPeer) {
        break;
      }
    }

    // Cleanup
    sub.close();
    pool.close([localRelay]);

    console.log('\n=== Results ===');
    console.log(`Peers discovered: ${discoveredPeers.size}`);
    console.log(`Found rust: ${foundRsPeer}`);
    console.log(`Received offer from rust: ${receivedOfferFromRsPeer}`);

    // Verify rust's peerId was correctly received
    if (rsPeerPubkey && foundRsPeer) {
      const rsPeer = discoveredPeers.get(rsPeerPubkey);
      console.log(`rust peerId: ${rsPeer?.peerId}`);
      expect(rsPeer?.peerId).toBe(rsPeerPubkey);
    }

    expect(foundRsPeer || receivedOfferFromRsPeer).toBe(true);
  });

  test('rust responds to ts peer via relay', async () => {
    if (!rsPeerPubkey) {
      throw new Error('rust pubkey not captured');
    }

    const pool = new SimplePool();
    const tsSk = tsSecretKey;
    const tsPk = tsPubkey;

    console.log('TypeScript peer pubkey:', tsPk.slice(0, 16) + '...');
    console.log('TypeScript peer ID:', tsPk);

    let receivedOfferFromRs = false;

    const since = Math.floor(Date.now() / 1000) - 30;
    const sub = pool.subscribe(
      [localRelay],
      [
        {
          kinds: [WEBRTC_KIND],
          '#l': [HELLO_TAG],
          since,
        },
        {
          kinds: [WEBRTC_KIND],
          '#p': [tsPk],
          since,
        },
      ],
      {
        onevent(event: Event) {
          if (event.pubkey === tsPk) return;
          try {
            let content = event.content;
            if (!content) return;

            let senderPubkey = event.pubkey;
            if (!content.startsWith('{')) {
              const unwrapped = unwrapGiftContent(tsSk, event.pubkey, content);
              if (!unwrapped) {
                return;
              }
              content = unwrapped.content;
              senderPubkey = unwrapped.senderPubkey;
            }
            const msg = JSON.parse(content);
            if (msg.type === 'offer') {
              if (typeof msg.targetPeerId !== 'string' || 'recipient' in msg) {
                throw new Error(`unexpected rust signaling shape: ${content}`);
              }
              if (msg.targetPeerId === tsPk && senderPubkey === rsPeerPubkey) {
                receivedOfferFromRs = true;
                console.log('*** RECEIVED OFFER FROM HASHTREE-RS ***');
              }
            }
          } catch {
            // Ignore parse errors
          }
        },
      }
    );

    await new Promise(r => setTimeout(r, 1000));

    // Send hellos to prompt an offer from rust
    for (let i = 0; i < 30; i++) {
      const expiration = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);
      const helloEvent = finalizeEvent({
        kind: WEBRTC_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['l', HELLO_TAG],
          ['peerId', tsPk],
          ['expiration', expiration.toString()],
        ],
        content: '',
      }, tsSk);

      await publishWithRetry(pool, localRelay, helloEvent);
      await new Promise(r => setTimeout(r, 2000));

      console.log(`Check ${i + 1}: received offer from rust = ${receivedOfferFromRs}`);

      if (receivedOfferFromRs) {
        break;
      }
    }

    sub.close();
    pool.close([localRelay]);

    console.log('\n=== Results ===');
    console.log(`Received offer from rust: ${receivedOfferFromRs}`);

    expect(receivedOfferFromRs).toBe(true);
  });
});
