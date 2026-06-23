import { expect, test, type Browser, type Page } from './fixtures';
import {
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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function configureNativeBlossom(configDir: string): void {
  runIdriveJson(configDir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
  runIdriveJson(configDir, ['blossom-servers', 'add', getTestBlossomUrl()]);
}

type StoredIrisIdentitySessionForTest = {
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

function readNativeIrisIdentitySession(configDir: string, label = 'native-e2e'): StoredIrisIdentitySessionForTest {
  const nsec = fs.readFileSync(path.join(configDir, 'key'), 'utf8').trim();
  const configToml = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
  const profileId = configToml.match(/\[profile\][\s\S]*?profile_id = "([^"]+)"/)?.[1];
  if (!profileId) {
    throw new Error('Native config is missing profile_id');
  }
  const rosterOps = Array.from(configToml.matchAll(/event_json = '([^']+)'/g)).map((match) => {
    const eventJson = match[1];
    const event = JSON.parse(eventJson);
    return {
      op_id: event.id,
      signer_pubkey: event.pubkey,
      content: JSON.parse(event.content),
      event_json: eventJson,
    };
  });
  if (rosterOps.length === 0) {
    throw new Error('Native config is missing IrisProfile roster ops');
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
  irisIdentitySession?: StoredIrisIdentitySessionForTest,
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
    }, { secret: nsec, session: irisIdentitySession ?? null });
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
    const result = await createTree('main', 'private', true);
    if (!result.success) {
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

async function waitForRemoteTreeRoot(page: Page, npub: string, treeName: string): Promise<void> {
  await page.evaluate(async ({ owner, tree, timeout }) => {
    const { waitForTreeRoot } = await import('/src/stores');
    const root = await waitForTreeRoot(owner, tree, timeout);
    if (!root?.hash) {
      throw new Error(`Timed out waiting for tree root ${owner}/${tree}`);
    }
  }, { owner: npub, tree: treeName, timeout: 60000 });
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
): Promise<void> {
  await page.goto(`/#/${encodeURIComponent(npub)}/${encodeURIComponent(treeName)}`);
  await waitForAppReady(page, 60000);
  await waitForRemoteTreeRoot(page, npub, treeName);
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

function expectNativeFile(configDir: string, fileName: string, expectedContent: string): void {
  const listing = runIdriveJson(configDir, ['list']);
  const file = listing.files.find((entry: any) => entry.path === fileName);
  expect(file).toBeTruthy();
  expect(file.size).toBe(Buffer.byteLength(expectedContent));
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
      const init = runIdriveJson(configDir, ['init', '--label', 'native-e2e']);
      const identitySession = readNativeIrisIdentitySession(configDir);
      await prepareFreshPage(page, relayUrl, identitySession.appKeyNsec, identitySession);
      await createPrivateDriveTree(page);
      const appKeyNpub = init.current_app_key_npub;
      await page.goto(`/#/${encodeURIComponent(appKeyNpub)}/main`);
      await waitForAppReady(page, 60000);
      await waitForRemoteTreeRoot(page, appKeyNpub, 'main');
      await createFileWithContent(page, fileName, content);
      await flushPendingPublishes(page);
      await pushCurrentRootToBlossom(page, 'main');

      const sync = runIdriveJson(configDir, ['sync', '--relay', relayUrl, '--timeout', '2']);
      expect(sync.files_root_event_seen).toBe(true);
      expect(sync.drive_root_events_applied).toBeGreaterThan(0);
      expect(sync.blossom_download?.fetched ?? 0).toBeGreaterThan(0);
      expectNativeFile(configDir, fileName, content);
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
        const { getCurrentIrisIdentitySession, linkDriveDevice } = await import('/src/nostr');
        const result = await linkDriveDevice(nativeInvite);
        const session = getCurrentIrisIdentitySession();
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
});
