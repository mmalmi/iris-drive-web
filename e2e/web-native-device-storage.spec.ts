// A browser and a native Iris Drive linked to one account each show, under
// Storage, both devices with numbers: each device measures what it holds and
// sends the other an encrypted report (`src/drive/deviceStorageReport.ts`;
// native `crates/iris-drive-core/src/device_storage`). The native device is
// read through `idrive storage`, which prints what its apps show.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable, fileRow, getTestBlossomUrl } from './test-utils';
import { configureNativeRelay, idriveBin, irisDriveAvailable, runIdriveJson } from './native-idrive';

const FILE = { name: 'native-storage-notes.txt', line: 'Notes the browser wrote for the native device to hold. ' };

interface NativeRow {
  pubkey: string;
  name: string;
  is_current: boolean;
  app: string;
  has_report: boolean;
  held_label: string;
  sync_label: string;
  space_label: string;
  folders: Array<{ label: string }>;
}

function nativeLinkInvite(profileId: string, adminAppKeyPubkey: string): string {
  const payload = {
    v: 1,
    profileId,
    adminAppKeyNpub: nip19.npubEncode(adminAppKeyPubkey),
    inviteNpub: nip19.npubEncode(getPublicKey(generateSecretKey())),
  };
  return `https://drive.iris.to/invite/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function nativeRows(configDir: string): NativeRow[] {
  return runIdriveJson<{ devices: NativeRow[] }>(configDir, ['storage']).devices;
}

function webRow(page: Page, current: boolean) {
  return page.getByTestId('device-storage-row').filter(current ? { hasText: 'This device' } : { hasNotText: 'This device' });
}

test('a native device and a browser each show how much of the Drive the other holds', async ({ page, relayUrl }, testInfo) => {
  test.skip(!irisDriveAvailable(), 'iris-drive repo not available');
  test.setTimeout(480_000);
  const nativeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-storage-'));
  let daemon: ReturnType<typeof spawn> | null = null;
  page.on('console', (message) => {
    if (message.text().includes('deviceStorage')) console.log('browser:', message.text().slice(0, 300));
  });
  try {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Native Storage');
    await expectFolderEditable(page);
    // A name never used before, so the file server has no copy from an earlier run.
    await page.getByTestId('upload-files-input').setInputFiles([{
      name: FILE.name,
      mimeType: 'text/plain',
      buffer: Buffer.from(`${Date.now()}\n${FILE.line.repeat(2000)}`),
    }]);
    await expect(fileRow(page, FILE.name)).toBeVisible({ timeout: 60_000 });
    const owner = await page.evaluate(async () => {
      const { getCurrentNostrIdentitySession } = await import('/src/nostr');
      return getCurrentNostrIdentitySession()?.appKeyPubkey ?? '';
    });
    expect(owner).toMatch(/^[0-9a-f]{64}$/);

    const request = runIdriveJson<{ app_key_link_request: { url: string } }>(nativeConfig, [
      'link', nativeLinkInvite(profileId, owner), '--label', 'Native device',
    ]);
    configureNativeRelay(nativeConfig, relayUrl);
    runIdriveJson(nativeConfig, ['blossom-servers', 'remove', 'https://upload.iris.to']);
    runIdriveJson(nativeConfig, ['blossom-servers', 'add', getTestBlossomUrl()]);
    await page.goto(`${new URL(page.url()).origin}/#/settings/user`);
    await page.getByTestId('device-approval-input').fill(request.app_key_link_request.url);
    await page.getByTestId('approve-device-request').click();
    await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30_000 });
    const sync = runIdriveJson<{ device_approval_receipts_applied: number }>(nativeConfig, [
      'sync', '--relay', relayUrl, '--timeout', '3',
    ]);
    expect(sync.device_approval_receipts_applied).toBe(1);

    daemon = spawn(idriveBin(), ['daemon', '--relay', relayUrl, '--no-gateway'], {
      env: { ...process.env, IRIS_DRIVE_CONFIG_DIR: nativeConfig },
      stdio: 'ignore',
    });

    // The browser shows the native device with its numbers once it has measured.
    await page.goto(`${new URL(page.url()).origin}/#/settings/storage`);
    await expect(page.getByTestId('device-storage-row')).toHaveCount(2, { timeout: 60_000 });
    await expect(webRow(page, true).getByTestId('device-storage-held')).toHaveText('All of it', { timeout: 60_000 });
    const native = webRow(page, false);
    await expect(native).toContainText('Native device');
    await expect(native.getByTestId('device-storage-held')).not.toHaveText('No report yet', { timeout: 300_000 });
    await expect(native.getByTestId('device-storage-space')).toContainText(/Uses .+ of .+ allowed/);
    await expect(native.getByTestId('device-storage-sync')).toHaveText('In sync', { timeout: 120_000 });

    // The native device shows the browser with its numbers, and itself.
    await expect.poll(() => {
      const rows = nativeRows(nativeConfig);
      const browser = rows.find((row) => !row.is_current);
      return { devices: rows.length, browser: browser?.held_label, app: browser?.app, sync: browser?.sync_label };
    }, { timeout: 120_000, intervals: [1_000, 2_000, 5_000] }).toEqual({
      devices: 2, browser: 'All of it', app: 'web', sync: 'In sync',
    });
    const rows = nativeRows(nativeConfig);
    const own = rows.find((row) => row.is_current)!;
    expect(own.has_report).toBe(true);
    expect(own.app).toMatch(/^(macos|linux|windows)$/);
    expect(own.space_label).toMatch(/^Uses .+ of .+ allowed$/);
    expect(rows.find((row) => !row.is_current)!.folders.map((folder) => folder.label)).toContain('1 file not in a folder');
    fs.writeFileSync(testInfo.outputPath('native-storage.json'), JSON.stringify(rows, null, 2));

    await native.getByRole('button').first().click();
    await expect(native.getByTestId('device-storage-folders')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('web-storage-with-native.png'), fullPage: true });
  } finally {
    if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM');
    // What the native device knew, for a failure to be read afterwards.
    for (const name of fs.readdirSync(nativeConfig)) {
      const file = path.join(nativeConfig, name);
      if (/\.(json|toml)$/.test(name) && fs.statSync(file).isFile()) fs.copyFileSync(file, testInfo.outputPath(`native-${name}`));
    }
    fs.rmSync(nativeConfig, { recursive: true, force: true });
  }
});
