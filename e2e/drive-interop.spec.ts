import { expect, test, type Browser, type Page } from './fixtures';
import {
  addFileViaTreeAPI,
  clearAllStorage,
  configureBlossomServers,
  flushPendingPublishes,
  getTestBlossomUrl,
  navigateToPublicFolder,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNostrIdentityRosterOpEvent } from '../src/drive/protocol';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const defaultIrisDriveRepo = path.resolve(appDir, '../iris-drive');

function repoRoot(): string {
  return process.env.IRIS_DRIVE_REPO || defaultIrisDriveRepo;
}

function idriveBin(): string {
  if (process.env.IRIS_DRIVE_BIN) {
    return process.env.IRIS_DRIVE_BIN;
  }

  const repo = repoRoot();
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: repo,
    encoding: 'utf8',
  }));
  const targetDirRaw = process.env.CARGO_TARGET_DIR || metadata.target_directory || path.join(repo, 'target');
  const targetDir = path.isAbsolute(targetDirRaw) ? targetDirRaw : path.resolve(repo, targetDirRaw);
  const debugBin = path.join(targetDir, 'debug', process.platform === 'win32' ? 'idrive.exe' : 'idrive');
  if (fs.existsSync(debugBin)) {
    return debugBin;
  }

  execFileSync('cargo', ['build', '-p', 'idrive'], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (!fs.existsSync(debugBin)) {
    throw new Error(`idrive build finished but ${debugBin} was not found`);
  }
  return debugBin;
}

function runIdriveJson(configDir: string, args: string[]): any {
  const stdout = execFileSync(idriveBin(), args, {
    env: { ...process.env, IRIS_DRIVE_CONFIG_DIR: configDir },
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function startIdriveDaemon(configDir: string, relayUrl: string): ChildProcess {
  return spawn(idriveBin(), ['daemon', '--relay', relayUrl, '--no-gateway'], {
    env: { ...process.env, IRIS_DRIVE_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopIdriveDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGINT');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function configureNativeBlossom(configDir: string): void {
  runIdriveJson(configDir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
  runIdriveJson(configDir, ['blossom-servers', 'add', getTestBlossomUrl()]);
}

type StoredNostrIdentitySessionForTest = {
  schema: 1;
  profileId: string;
  appKeyNsec: string;
  status: 'active';
  rosterOps: Array<{
    op_id: string;
    signer_pubkey: string;
    content: unknown;
    event_json: string;
  }>;
  createdAt: number;
  label?: string;
};

type BlossomPushDetails = {
  hashHex: string;
  keyHex?: string;
  pushed: number;
  skipped: number;
  failed: number;
  blossomUrl: string;
  blockHashes: string[];
};

function readNativeNostrIdentitySession(configDir: string, label = 'native-e2e'): StoredNostrIdentitySessionForTest {
  const nsec = fs.readFileSync(path.join(configDir, 'key'), 'utf8').trim();
  const configToml = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
  const profileId = configToml.match(/\[profile\][\s\S]*?profile_id = "([^"]+)"/)?.[1];
  if (!profileId) {
    throw new Error('Native config is missing profile_id');
  }
  const rosterOps = Array.from(configToml.matchAll(/event_json = '([^']+)'/g)).map((match) => {
    const eventJson = match[1];
    const event = JSON.parse(eventJson);
    return parseNostrIdentityRosterOpEvent(event);
  });
  if (rosterOps.length === 0) {
    throw new Error('Native config is missing NostrIdentity roster ops');
  }

  return {
    schema: 1,
    profileId,
    appKeyNsec: nsec,
    status: 'active',
    rosterOps,
    createdAt: Math.floor(Date.now() / 1000),
    label,
  };
}

async function prepareFreshPage(
  page: Page,
  relayUrl: string,
  nsec?: string,
  nostrIdentitySession?: StoredNostrIdentitySessionForTest,
): Promise<void> {
  setupPageErrorHandler(page);
  await page.goto('/');
  await clearAllStorage(page);
  await presetLocalRelayInDB(page, relayUrl);
  if (nsec) {
    await page.evaluate(({ secret, session }) => {
      localStorage.setItem('hashtree:loginType', 'nsec');
      localStorage.setItem('hashtree:nsec', secret);
      if (session) {
        localStorage.setItem('iris:identity:session', JSON.stringify(session));
      }
    }, { secret: nsec, session: nostrIdentitySession ?? null });
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  if (nsec) {
    await page.waitForFunction(() => {
      const store = (window as any).__nostrStore;
      return store?.getState?.().pubkey?.length === 64;
    }, { timeout: 30000 });
  }
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30000);
}

async function createLegacyWebOwnerDeviceInvite(page: Page): Promise<string> {
  const invite = await page.evaluate(async () => {
    const { createDriveDeviceLinkInvite, createDriveProfile } = await import('/src/nostr');
    await createDriveProfile();
    return createDriveDeviceLinkInvite();
  });
  await flushPendingPublishes(page);
  return invite.url;
}

async function createFileWithContent(page: Page, fileName: string, content: string): Promise<void> {
  await page.getByRole('button', { name: 'New File' }).click();
  const nameInput = page.locator('input[placeholder="File name..."]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(fileName);
  const modal = page.locator('.fixed.inset-0').filter({ has: nameInput }).last();
  await modal.getByRole('button', { name: 'Create' }).click();

  const editor = page.locator('textarea');
  await expect(editor).toBeVisible({ timeout: 30000 });
  await editor.fill(content);

  const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ });
  if (await saveButton.isEnabled().catch(() => false)) {
    await saveButton.click();
  }
  await expect(saveButton).toBeDisabled({ timeout: 30000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(editor).not.toBeVisible({ timeout: 30000 });
}

async function createPrivateDriveTree(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { createTree } = await import('/src/actions');
    const { getTreeRootSync } = await import('/src/stores');
    const rootScope = (): string | null => {
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      if (stored?.status === 'active' && typeof stored.profileId === 'string') {
        return stored.profileId;
      }
      return (window as any).__nostrStore?.getState?.().npub ?? null;
    };
    const hasMainRoot = (): boolean => {
      const scope = rootScope();
      return !!scope && !!getTreeRootSync(scope, 'main')?.hash;
    };
    if (hasMainRoot()) return;
    const result = await createTree('main', 'private', true);
    if (!result.success && !hasMainRoot()) {
      throw new Error('Failed to create private main drive');
    }
  });
  await flushPendingPublishes(page);
}

async function pushCurrentRootToBlossom(page: Page, treeName: string): Promise<void> {
  await page.evaluate(async (targetTree: string) => {
    const { getTreeRootSync } = await import('/src/stores');
    const npub = (window as any).__nostrStore?.getState?.().npub;
    const root = npub ? getTreeRootSync(npub, targetTree) : null;
    if (!root?.hash) {
      throw new Error(`No root for ${targetTree}`);
    }
    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (!adapter?.pushToBlossom) {
      throw new Error('Worker adapter has no pushToBlossom');
    }
    const result = await adapter.pushToBlossom(root.hash, root.key, targetTree);
    if (result.failed > 0) {
      throw new Error(`Blossom push failed: ${JSON.stringify(result)}`);
    }
  }, treeName);
}

async function verifyBlossomBlocksFromNode(details: BlossomPushDetails): Promise<void> {
  for (const hashHex of details.blockHashes) {
    const response = await fetch(`${details.blossomUrl}/${hashHex}.bin`);
    if (!response.ok) {
      throw new Error(`Node could not GET Blossom block ${hashHex} from ${details.blossomUrl}: ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== hashHex) {
      throw new Error(`Node Blossom block hash mismatch for ${hashHex}: got ${digest}`);
    }
  }
}

async function pushProfileRootToBlossom(page: Page, profileId: string, treeName: string): Promise<BlossomPushDetails> {
  const details = await page.evaluate(async ({ profile, tree, blossomUrl }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const { getTree } = await import('/src/store');
    const toHex = (bytes: Uint8Array): string => Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const assertReadableBlock = async (hashHex: string): Promise<void> => {
      const response = await fetch(`${blossomUrl}/${hashHex}.bin`);
      if (!response.ok) {
        throw new Error(`Browser could not GET Blossom block ${hashHex}: ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const actualHash = toHex(new Uint8Array(digest));
      if (actualHash !== hashHex) {
        throw new Error(`Browser Blossom block hash mismatch for ${hashHex}: got ${actualHash}`);
      }
    };
    const root = getTreeRootSync(profile, tree);
    if (!root?.hash) {
      throw new Error(`No root for ${profile}/${tree}`);
    }
    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (!adapter?.pushToBlossom) {
      throw new Error('Worker adapter has no pushToBlossom');
    }
    const result = await adapter.pushToBlossom(root.hash, root.key, tree);
    if (result.failed > 0) {
      throw new Error(`Blossom push failed: ${JSON.stringify(result)}`);
    }
    const hashtree = getTree();
    const blockHashes: string[] = [];
    for await (const block of hashtree.walkBlocks(root)) {
      const hashHex = toHex(block.hash);
      blockHashes.push(hashHex);
      await assertReadableBlock(hashHex);
    }
    return {
      hashHex: toHex(root.hash),
      keyHex: root.key ? toHex(root.key) : undefined,
      pushed: result.pushed,
      skipped: result.skipped,
      failed: result.failed,
      blossomUrl,
      blockHashes,
    };
  }, { profile: profileId, tree: treeName, blossomUrl: getTestBlossomUrl() });

  await verifyBlossomBlocksFromNode(details);
  return details;
}

async function waitForRemoteTreeRoot(page: Page, npub: string, treeName: string): Promise<void> {
  await page.evaluate(async ({ owner, tree, timeout }) => {
    const { waitForTreeRoot } = await import('/src/stores');
    const root = await waitForTreeRoot(owner, tree, timeout);
    if (!root?.hash) {
      throw new Error(`Timed out waiting for tree root ${owner}/${tree}`);
    }
  }, { owner: npub, tree: treeName, timeout: 60000 });
}

async function waitForRemoteTreeRootHash(
  page: Page,
  npub: string,
  treeName: string,
  expectedRootHash: string,
): Promise<void> {
  await page.evaluate(async ({ owner, tree }) => {
    const { refreshDriveRootResolverKey } = await import('/src/stores/treeRootResolver.ts');
    refreshDriveRootResolverKey(`${owner}/${tree}`);
  }, { owner: npub, tree: treeName });

  await expect.poll(
    () => page.evaluate(async ({ owner, tree }) => {
      const { getTreeRootSync } = await import('/src/stores');
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const root = getTreeRootSync(owner, tree);
      if (root?.hash) return toHex(root.hash);
      return null;
    }, { owner: npub, tree: treeName }),
    { timeout: 60000, intervals: [500, 1000, 2000] },
  ).toBe(expectedRootHash);
}

type RelayDriveRootDiagnostic = {
  id: string;
  pubkey: string;
  created_at: number;
  root_hash: string | null;
  app_key_seq: number | null;
  dck_generation: number | null;
  d: string | null;
};

async function fetchRelayDriveRootHashes(
  page: Page,
  relayUrl: string,
  profileId: string,
  treeName: string,
): Promise<RelayDriveRootDiagnostic[]> {
  return page.evaluate(async ({ relay, profile, tree }) => {
    const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
    const dTag = driveRootDTag(profile, tree);

    return new Promise<RelayDriveRootDiagnostic[]>((resolve, reject) => {
      const events: RelayDriveRootDiagnostic[] = [];
      const subId = `drive-root-${Math.random().toString(36).slice(2)}`;
      const socket = new WebSocket(relay);
      const timeout = window.setTimeout(() => {
        socket.close();
        resolve(events);
      }, 3000);

      socket.onopen = () => {
        socket.send(JSON.stringify(['REQ', subId, {
          kinds: [KIND_DRIVE_ROOT],
          '#d': [dTag],
          limit: 50,
        }]));
      };
      socket.onmessage = (message) => {
        const data = JSON.parse(String(message.data));
        if (data[0] === 'EVENT') {
          const event = data[2];
          let rootHash: string | null = null;
          let appKeySeq: number | null = null;
          let dckGeneration: number | null = null;
          try {
            const content = JSON.parse(event.content);
            rootHash = content?.root_hash ?? null;
            appKeySeq = typeof content?.app_key_seq === 'number' ? content.app_key_seq : null;
            dckGeneration = typeof content?.dck_generation === 'number' ? content.dck_generation : null;
          } catch {
            rootHash = null;
          }
          events.push({
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            root_hash: rootHash,
            app_key_seq: appKeySeq,
            dck_generation: dckGeneration,
            d: event.tags?.find((tag: string[]) => tag[0] === 'd')?.[1] ?? null,
          });
        }
        if (data[0] === 'EOSE') {
          window.clearTimeout(timeout);
          socket.send(JSON.stringify(['CLOSE', subId]));
          socket.close();
          resolve(events);
        }
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error(`relay websocket error: ${relay}`));
      };
    });
  }, { relay: relayUrl, profile: profileId, tree: treeName });
}

async function waitForPublishedProfileRoot(
  page: Page,
  relayUrl: string,
  profileId: string,
  treeName: string,
  expectedRootHash: string,
): Promise<void> {
  try {
    await expect.poll(
      async () => {
        const events = await fetchRelayDriveRootHashes(page, relayUrl, profileId, treeName);
        return events.some((event) => event.root_hash === expectedRootHash);
      },
      { timeout: 30000, intervals: [500, 1000, 2000] },
    ).toBe(true);
  } catch (error) {
    const relayEvents = await fetchRelayDriveRootHashes(page, relayUrl, profileId, treeName)
      .catch((relayError) => [{
        id: 'relay-error',
        pubkey: String(relayError),
        created_at: 0,
        root_hash: null,
        app_key_seq: null,
        dck_generation: null,
        d: null,
      }]);
    const diagnostics = await page.evaluate(async ({ profile, tree, expectedHash }) => {
      const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
      const { ndk } = await import('/src/nostr');
      const events = Array.from(await ndk.fetchEvents({
        kinds: [KIND_DRIVE_ROOT],
        '#d': [driveRootDTag(profile, tree)],
        limit: 50,
      }));
      return {
        expectedHash,
        hash: window.location.hash,
        relayStats: await (window as any).__getWorkerAdapter?.()?.getRelayStats?.().catch((statsError: unknown) => ({
          error: String(statsError),
        })),
        ndkEvents: events.map((event) => {
          try {
            return {
              id: event.id,
              pubkey: event.pubkey,
              created_at: event.created_at,
              root_hash: JSON.parse(event.content)?.root_hash ?? null,
              app_key_seq: JSON.parse(event.content)?.app_key_seq ?? null,
              dck_generation: JSON.parse(event.content)?.dck_generation ?? null,
              d: event.tags?.find((tag) => tag[0] === 'd')?.[1] ?? null,
            };
          } catch {
            return {
              id: event.id,
              pubkey: event.pubkey,
              created_at: event.created_at,
              root_hash: null,
              app_key_seq: null,
              dck_generation: null,
              d: event.tags?.find((tag) => tag[0] === 'd')?.[1] ?? null,
            };
          }
        }),
      };
    }, { profile: profileId, tree: treeName, expectedHash: expectedRootHash })
      .catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nPublish diagnostics:\n${JSON.stringify({ ...diagnostics, relayEvents }, null, 2)}`);
  }
}

async function readTreeFile(page: Page, npub: string, treeName: string, fileName: string): Promise<string | null> {
  return page.evaluate(async ({ owner, treeName: targetTree, fileName: targetFile }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const { getTree } = await import('/src/store');
    const root = getTreeRootSync(owner, targetTree);
    if (!root?.hash) return null;
    const tree = getTree();
    const entry = await tree.resolvePath(root, targetFile).catch(() => null);
    if (!entry?.cid) return null;
    const data = await tree.readFile(entry.cid).catch(() => null);
    return data ? new TextDecoder().decode(data) : null;
  }, { owner: npub, treeName, fileName });
}

async function expectTreeFile(
  page: Page,
  npub: string,
  treeName: string,
  fileName: string,
  expectedContent: string,
  expectedRootHash?: string,
): Promise<void> {
  await page.goto(`/#/${encodeURIComponent(npub)}/${encodeURIComponent(treeName)}`);
  await waitForAppReady(page, 60000);
  await waitForRemoteTreeRoot(page, npub, treeName);
  if (expectedRootHash) {
    await waitForRemoteTreeRootHash(page, npub, treeName, expectedRootHash);
  }
  await expect.poll(
    () => readTreeFile(page, npub, treeName, fileName),
    { timeout: 90000, intervals: [1000, 2000, 3000] },
  ).toBe(expectedContent);
}

function generateNsec(): { nsec: string; npub: string } {
  const secret = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(getPublicKey(secret)),
  };
}

function rootHashFromRootCid(rootCid: unknown): string {
  if (typeof rootCid !== 'string') {
    throw new Error(`Expected root_cid string, got ${typeof rootCid}`);
  }
  const hash = rootCid.split(':')[0] ?? '';
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid root_cid hash: ${rootCid}`);
  }
  return hash;
}

async function waitForNativeFiles(
  configDir: string,
  relayUrl: string,
  expected: Array<{ fileName: string; content: string }>,
  diagnostics?: Record<string, unknown>,
): Promise<void> {
  const expectedFiles = expected.map(({ fileName, content }) => ({
    fileName,
    present: true,
    size: Buffer.byteLength(content),
    expectedSize: Buffer.byteLength(content),
  }));
  const deadline = Date.now() + 90000;
  let last: unknown = null;

  while (Date.now() < deadline) {
    const sync = runIdriveJson(configDir, ['sync', '--relay', relayUrl, '--timeout', '5']);
    const listing = runIdriveJson(configDir, ['list']);
    const status = runIdriveJson(configDir, ['status']);
    const files = expected.map(({ fileName, content }) => {
      const file = listing.files.find((entry: any) => entry.path === fileName);
      return {
        fileName,
        present: !!file,
        size: file?.size ?? -1,
        expectedSize: Buffer.byteLength(content),
      };
    });
    last = {
      files,
      sync: {
        profile_roster_ops_seen: sync.profile_roster_ops_seen,
        profile_roster_ops_applied: sync.profile_roster_ops_applied,
        drive_root_events_seen: sync.drive_root_events_seen,
        drive_root_events_applied: sync.drive_root_events_applied,
        drive_root_events_skipped: sync.drive_root_events_skipped,
        files_root_event_seen: sync.files_root_event_seen,
        files_root_event_outcome: sync.files_root_event_outcome,
        fips_download: sync.fips_download,
        fips_download_error: sync.fips_download_error,
        blossom_download: sync.blossom_download,
        blossom_download_error: sync.blossom_download_error,
        materialized_root_cid: sync.materialized_root_cid,
        blossom_servers: sync.blossom_servers,
      },
      profile: status.profile,
      drives: status.drives,
      listing,
      diagnostics,
    };
    if (JSON.stringify(files) === JSON.stringify(expectedFiles)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Native files did not converge:\n${JSON.stringify(last, null, 2)}`);
}

test.describe('Iris Drive web interop', () => {
  test.setTimeout(180000);

  test('native idrive publish is readable from drive web', async ({ page, relayUrl }) => {
    test.skip(!fs.existsSync(repoRoot()), 'iris-drive repo not available');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-web-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-work-'));
    const fileName = 'native-web.txt';
    const content = `native to web ${Date.now()}`;

    try {
      configureNativeBlossom(configDir);
      const init = runIdriveJson(configDir, ['init', '--label', 'native-e2e']);
      fs.writeFileSync(path.join(workDir, fileName), content);
      runIdriveJson(configDir, ['import', workDir]);
      const publish = runIdriveJson(configDir, ['publish', '--relay', relayUrl, '--timeout', '2']);
      expect(publish.published_files_root).toBe(true);
      expect(publish.drive_iris_to_url).toBe(`https://drive.iris.to/#/${init.profile_id}/main`);

      const ownerNsec = fs.readFileSync(path.join(configDir, 'key'), 'utf8').trim();
      await prepareFreshPage(page, relayUrl, ownerNsec);
      await expectTreeFile(page, init.profile_id, 'main', fileName, content);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('web publish is readable from a second web profile', async ({ page, browser, relayUrl }) => {
    const owner = generateNsec();
    const fileName = 'web-web.txt';
    const content = `web to web ${Date.now()}`;

    await prepareFreshPage(page, relayUrl, owner.nsec);
    await navigateToPublicFolder(page, { timeoutMs: 60000 });
    await createFileWithContent(page, fileName, content);
    await flushPendingPublishes(page);
    await pushCurrentRootToBlossom(page, 'public');

    const context = await (browser as Browser).newContext();
    const viewer = await context.newPage();
    try {
      await prepareFreshPage(viewer, relayUrl);
      await expectTreeFile(viewer, owner.npub, 'public', fileName, content);
    } finally {
      await context.close();
    }
  });

  test('drive web publish is readable from native idrive', async ({ page, relayUrl }) => {
    test.skip(!fs.existsSync(repoRoot()), 'iris-drive repo not available');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-web-native-'));
    const fileName = 'web-native.txt';
    const content = `web to native ${Date.now()}`;

    try {
      configureNativeBlossom(configDir);
      runIdriveJson(configDir, ['init', '--label', 'native-e2e']);
      const identitySession = readNativeNostrIdentitySession(configDir);
      await prepareFreshPage(page, relayUrl, identitySession.appKeyNsec, identitySession);
      await createPrivateDriveTree(page);
      const profileId = identitySession.profileId;
      await page.goto(`/#/${encodeURIComponent(profileId)}/main`);
      await waitForAppReady(page, 60000);
      await waitForRemoteTreeRoot(page, profileId, 'main');
      const webRoot = await addFileViaTreeAPI(page, [], fileName, content);
      expect(webRoot).toBeTruthy();
      await flushPendingPublishes(page);
      await waitForPublishedProfileRoot(page, relayUrl, profileId, 'main', webRoot);
      const webPush = await pushProfileRootToBlossom(page, profileId, 'main');
      const relayRoots = await fetchRelayDriveRootHashes(page, relayUrl, profileId, 'main');

      await waitForNativeFiles(configDir, relayUrl, [
        { fileName, content },
      ], { webPush, relayRoots });
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('native idrive device-link invite creates pending drive-web identity session', async ({ page, relayUrl }) => {
    test.skip(!fs.existsSync(repoRoot()), 'iris-drive repo not available');

    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-link-web-'));

    try {
      const owner = runIdriveJson(configDir, ['init', '--label', 'native-admin']);
      const invite = owner.app_key_link_invite?.url;
      expect(invite).toEqual(expect.stringMatching(/^https:\/\/drive\.iris\.to\/invite\//));
      const adminAppKeyNpub = owner.current_app_key_npub;
      expect(adminAppKeyNpub).toEqual(expect.stringMatching(/^npub1/));
      const decodedAdmin = nip19.decode(adminAppKeyNpub);
      expect(decodedAdmin.type).toBe('npub');
      const adminAppKeyPubkey = decodedAdmin.data as string;

      await prepareFreshPage(page, relayUrl);
      const linked = await page.evaluate(async (nativeInvite) => {
        const { getCurrentNostrIdentitySession, linkDriveDevice } = await import('/src/nostr');
        const result = await linkDriveDevice(nativeInvite);
        const session = getCurrentNostrIdentitySession();
        const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
        return {
          linkedNpub: result?.npub ?? null,
          session,
          stored,
        };
      }, invite);

      expect(linked.linkedNpub).toEqual(expect.stringMatching(/^npub1/));
      expect(linked.session?.profileId).toBe(owner.profile_id);
      expect(linked.session?.status).toBe('pending_device_link');
      expect(linked.session?.pendingDeviceLink?.adminAppKeyPubkey).toBe(adminAppKeyPubkey);
      expect(linked.session?.pendingDeviceLink?.profileId).toBe(owner.profile_id);
      expect(linked.session?.pendingDeviceLink?.deviceAppKeyPubkey).toBeTruthy();
      expect(linked.stored?.profileId).toBe(owner.profile_id);
      expect(linked.stored?.status).toBe('pending_device_link');
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('native idrive approval request can be pasted into web owner device settings', async ({ page, relayUrl }) => {
    test.setTimeout(300000);
    test.skip(!fs.existsSync(repoRoot()), 'iris-drive repo not available');

    const nativeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-link-request-'));
    const nativeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-link-work-'));
    let daemon: ChildProcess | null = null;

    try {
      await prepareFreshPage(page, relayUrl);
      const invite = await createLegacyWebOwnerDeviceInvite(page);
      expect(invite).toMatch(/^https:\/\/drive\.iris\.to\/invite\//);
      const profileId = await page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
        return stored?.profileId ?? '';
      });
      expect(profileId).toMatch(/^[0-9a-f-]{36}$/);

      const linked = runIdriveJson(nativeConfigDir, ['link', invite, '--label', 'iOS native']);
      const approvalRequest = linked.app_key_link_request?.url ?? '';
      expect(approvalRequest).toMatch(/^https:\/\/drive\.iris\.to\/approve-device\//);
      configureNativeBlossom(nativeConfigDir);
      daemon = startIdriveDaemon(nativeConfigDir, relayUrl);

      await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('device-approval-section')).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('user-add-device-section')).toHaveCount(0);
      await page.getByTestId('device-approval-input').fill(approvalRequest);
      await page.getByTestId('approve-device-request').click();
      await flushPendingPublishes(page);
      await expect.poll(async () => page.evaluate(async () => {
        const { getCurrentNostrIdentitySession } = await import('/src/nostr');
        const { projectNostrIdentityRoster } = await import('/src/drive/protocol');
        const session = getCurrentNostrIdentitySession();
        const projection = session?.status === 'active'
          ? projectNostrIdentityRoster(session.profileId, session.rosterOps)
          : null;
        return {
          rowCount: document.querySelectorAll('[data-testid="user-key-row"]').length,
          activeCount: projection ? Object.keys(projection.active_facets).length : 0,
          rosterOps: session?.rosterOps.length ?? 0,
          error: document.querySelector('[data-testid="user-settings-error"]')?.textContent?.trim() ?? '',
        };
      }), { timeout: 45000 }).toMatchObject({
        rowCount: 2,
        activeCount: 2,
        error: '',
      });
      await expect(page.getByTestId('user-key-row').nth(1)).toContainText('iOS native');

      await expect.poll(() => {
        runIdriveJson(nativeConfigDir, ['sync', '--relay', relayUrl, '--timeout', '3']);
        const status = runIdriveJson(nativeConfigDir, ['status']);
        return {
          authorization: status.profile?.authorization_state,
          pendingRequest: status.profile?.app_key_link_request?.url ?? '',
        };
      }, { timeout: 90000, intervals: [1000, 2000, 5000] }).toEqual({
        authorization: 'authorized',
        pendingRequest: '',
      });

      const nativeFileName = 'native-linked.txt';
      const nativeContent = `native linked to web ${Date.now()}`;
      fs.writeFileSync(path.join(nativeWorkDir, nativeFileName), nativeContent);
      runIdriveJson(nativeConfigDir, ['import', nativeWorkDir]);
      const nativePublish = runIdriveJson(nativeConfigDir, ['publish', '--relay', relayUrl, '--timeout', '5']);
      expect(nativePublish.published_files_root).toBe(true);
      const nativeRootHash = rootHashFromRootCid(nativePublish.root_cid);
      await waitForPublishedProfileRoot(page, relayUrl, profileId, 'main', nativeRootHash);
      await expectTreeFile(page, profileId, 'main', nativeFileName, nativeContent, nativeRootHash);

      const webFileName = 'web-linked.txt';
      const webContent = `web linked to native ${Date.now()}`;
      const webRoot = await addFileViaTreeAPI(page, [], webFileName, webContent);
      expect(webRoot).toBeTruthy();
      await flushPendingPublishes(page);
      const webPush = await pushProfileRootToBlossom(page, profileId, 'main');
      await waitForNativeFiles(nativeConfigDir, relayUrl, [
        { fileName: nativeFileName, content: nativeContent },
        { fileName: webFileName, content: webContent },
      ], { webPush });
    } finally {
      if (daemon) await stopIdriveDaemon(daemon);
      fs.rmSync(nativeConfigDir, { recursive: true, force: true });
      fs.rmSync(nativeWorkDir, { recursive: true, force: true });
    }
  });
});
