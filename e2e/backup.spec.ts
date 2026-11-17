// Backup, as a person meets it: where their Drive is kept besides this
// device, each place with how it stands. A file server added here gets the
// Drive's locked parts, a check reads some of them back, and removing the
// place stops it. A folder on this computer works the same way, a backup
// left by a reload goes on, and the page fits a phone.
import { expect, test, type Page, type Route } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { configureBlossomServers, expectFolderEditable, fileRow } from './test-utils';

/** The e2e file server: it has never seen this test's Drive. */
const BACKUP_SERVER = process.env.PW_TEST_BLOSSOM_URL ?? 'http://127.0.0.1:18780';
const BACKUP_HOST = new URL(BACKUP_SERVER).host;
/** The Drive's everyday file server, kept by the test itself. */
const EVERYDAY = 'http://everyday-files.test';
const PHONE = { width: 390, height: 844 };
const JARGON = [/npub/i, /nsec/i, /nhash/i, /htree/i, /hashtree/i, /relay/i, /blossom/i, /nostr/i, /blob/i];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
};

/** A file server in the test: parts by hash, with an optional wait before each upload is answered. */
async function serveFiles(page: Page, origin: string, options: { uploadDelayMs?: number } = {}): Promise<Map<string, Buffer>> {
  const parts = new Map<string, Buffer>();
  await page.context().route(`${origin}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (request.method() === 'PUT' && url.pathname === '/upload') {
      if (options.uploadDelayMs) await new Promise((resolve) => setTimeout(resolve, options.uploadDelayMs));
      const hash = request.headers()['x-sha-256'];
      parts.set(hash, request.postDataBuffer() ?? Buffer.alloc(0));
      return route.fulfill({ status: 201, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ sha256: hash }) });
    }
    const part = parts.get(url.pathname.slice(1).replace(/\.bin$/, ''));
    if (!part) return route.fulfill({ status: 404, headers: CORS });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: part });
  });
  return parts;
}

/** Waits until the Drive's version has stayed the same for a few seconds, after a file was added. */
async function waitForDriveToSettle(page: Page, profileId: string): Promise<void> {
  let last = '';
  let since = Date.now();
  await expect.poll(async () => {
    const version = await page.evaluate(async (id) => {
      const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
      const root = getTreeRootSync(id, 'main');
      return root ? Array.from(root.hash, (byte: number) => byte.toString(16).padStart(2, '0')).join('') : '';
    }, profileId);
    if (version !== last) {
      last = version;
      since = Date.now();
    }
    return Boolean(version) && Date.now() - since >= 3_000;
  }, { timeout: 60_000, intervals: [250] }).toBe(true);
}

/** Signed in, with a Drive that holds a file, saved only to the test's everyday server. */
async function startWithDrive(page: Page, relayUrl: string, file = { name: 'notes.txt', bytes: 5_000 }): Promise<void> {
  await prepareFreshSession(page, relayUrl);
  await serveFiles(page, EVERYDAY);
  await configureBlossomServers(page, EVERYDAY);
  const { profileId } = await createDriveProfile(page, 'Backup Test');
  const seed = Date.now() % 251;
  await expectFolderEditable(page);
  await page.getByTestId('upload-files-input').setInputFiles([{
    name: file.name,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(Array.from({ length: file.bytes }, (_, index) => (index * 31 + seed) % 251)),
  }]);
  await expect(fileRow(page, file.name)).toBeVisible({ timeout: 60_000 });
  await waitForDriveToSettle(page, profileId);
}

async function openBackup(page: Page): Promise<ReturnType<Page['getByTestId']>> {
  // Backup is on the Storage page, below this device's own space.
  await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Storage' }).click();
  await expect(page).toHaveURL(/#\/settings\/storage$/);
  const panel = page.getByTestId('backup-settings');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

async function expectNoJargon(page: Page): Promise<void> {
  const panel = page.getByTestId('backup-settings');
  for (const word of JARGON) await expect(panel).not.toContainText(word);
}

test.describe('backup', () => {
  test.setTimeout(180_000);

  test('a file server added under Backup gets the Drive, passes a check, and can be removed', async ({ page, relayUrl }, testInfo) => {
    await startWithDrive(page, relayUrl);
    const panel = await openBackup(page);

    await expect(page.getByTestId('storage-settings').getByRole('heading', { name: 'On this device' })).toBeVisible();
    await expect(page.getByTestId('storage-size')).toBeVisible();
    await expect(page.getByTestId('backup-restore')).toContainText('recovery phrase');
    await expect(panel.getByRole('link', { name: 'Iris Drive app' })).toHaveAttribute('href', 'https://getdrive.iris.to/');
    await panel.screenshot({ path: testInfo.outputPath('backup.png') });
    const everyday = panel.getByRole('listitem', { name: 'everyday-files.test' });
    await expect(everyday).toContainText('File server');
    // The only server the Drive saves to stays: other devices get files through it.
    await expect(everyday.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await expectNoJargon(page);

    await panel.getByLabel('File server address').fill('files.example.com');
    await panel.getByRole('button', { name: 'Add backup server' }).click();
    await expect(panel.getByRole('alert')).toHaveText('Enter an address that starts with https://');

    await panel.getByLabel('File server address').fill(BACKUP_SERVER);
    await panel.getByRole('button', { name: 'Add backup server' }).click();
    const place = panel.getByRole('listitem', { name: BACKUP_HOST });
    await expect(place.getByTestId('backup-status')).toHaveText('Up to date', { timeout: 90_000 });
    const sent = Number((await place.textContent())?.match(/Last backup sent (\d+) new parts/)?.[1] ?? 0);
    expect(sent).toBeGreaterThan(0);

    // A check reads parts back from the server and compares them.
    await place.getByRole('button', { name: 'Check' }).click();
    await expect(place.getByTestId('backup-detail')).toHaveText(/^Checked just now: (\d+) of \1 parts read back$/, { timeout: 60_000 });
    await expect(place.getByTestId('backup-status')).toHaveText('Up to date');

    // Backing up again sends nothing new, and what happened is kept on this device.
    await place.getByRole('button', { name: 'Back up now' }).click();
    await expect(place).toContainText('Last backup sent 0 new parts', { timeout: 60_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(place.getByTestId('backup-status')).toHaveText('Up to date', { timeout: 60_000 });
    await expect(place.getByTestId('backup-detail')).toContainText('parts read back');

    await panel.getByRole('button', { name: 'Manage file servers' }).click();
    await expect(place.getByRole('checkbox', { name: 'Save backups', exact: true })).toBeChecked();
    await panel.screenshot({ path: testInfo.outputPath('backup-file-servers-desktop.png') });
    await place.getByRole('button', { name: 'Remove' }).click();
    await expect(place).toHaveCount(0);
    await expect(everyday).toBeVisible();
  });

  test('a folder on this computer gets the Drive and a small manifest', async ({ page, relayUrl }) => {
    await startWithDrive(page, relayUrl);
    // The folder picker returns a folder in the browser's own storage.
    await page.evaluate(() => {
      (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => (
        (await navigator.storage.getDirectory()).getDirectoryHandle('Drive backup', { create: true })
      );
    });
    const panel = await openBackup(page);
    await panel.getByRole('button', { name: 'Back up to a folder on this computer' }).click();
    const folder = panel.getByRole('listitem', { name: 'Drive backup' });
    await expect(folder).toContainText('Folder on this computer');
    await expect(folder.getByTestId('backup-status')).toHaveText('Up to date', { timeout: 60_000 });
    await expect(page.getByTestId('backup-restore')).toContainText('cannot read one back yet');

    const manifest = await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('Drive backup');
      return JSON.parse(await (await (await folder.getFileHandle('iris-drive-backup.json')).getFile()).text());
    });
    // It names the Drive version and nothing that opens it.
    expect(Object.keys(manifest).sort()).toEqual(['about', 'app', 'parts', 'root', 'updatedAt', 'version']);
    expect(manifest).toMatchObject({ app: 'Iris Drive', version: 1, root: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(manifest.parts).toBeGreaterThan(1);

    await folder.getByRole('button', { name: 'Check' }).click();
    await expect(folder.getByTestId('backup-detail')).toHaveText(/^Checked just now: (\d+) of \1 parts read back$/, { timeout: 60_000 });
    await folder.getByRole('button', { name: 'Remove' }).click();
    await expect(folder).toHaveCount(0);
  });

  test('a backup left by a reload goes on by itself', async ({ page, relayUrl }) => {
    // A file of several pieces, so the backup takes a while.
    await startWithDrive(page, relayUrl, { name: 'large.bin', bytes: 9 * 1024 * 1024 });
    const slowOrigin = 'http://slow-backup.test';
    await serveFiles(page, slowOrigin, { uploadDelayMs: 1_500 });
    const panel = await openBackup(page);
    await panel.getByLabel('File server address').fill(slowOrigin);
    await panel.getByRole('button', { name: 'Add backup server' }).click();
    const place = panel.getByRole('listitem', { name: 'slow-backup.test' });
    const status = place.getByTestId('backup-status');
    await expect(status).toHaveText(/^Backing up [1-9]\d* of \d+$/, { timeout: 60_000 });
    const [, done, total] = (await status.textContent())!.match(/(\d+) of (\d+)/)!.map(Number);
    expect(done).toBeLessThan(total);

    // Only the backup that was going can finish it: nothing else starts a first backup.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(status).toHaveText('Up to date', { timeout: 120_000 });
  });

  test('on a phone, Backup is in Settings under Storage and fits the screen', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize(PHONE);
    await startWithDrive(page, relayUrl);
    await page.goto(`${new URL(page.url()).origin}/#/settings`);
    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.getByTestId('settings-nav-storage')).toHaveText('Storage', { timeout: 30_000 });
    await nav.getByTestId('settings-nav-storage').click();
    await expect(page).toHaveURL(/#\/settings\/storage$/);

    const panel = page.getByTestId('backup-settings');
    await panel.getByLabel('File server address').fill(BACKUP_SERVER);
    await panel.getByRole('button', { name: 'Add backup server' }).click();
    const place = panel.getByRole('listitem', { name: BACKUP_HOST });
    await expect(place.getByTestId('backup-status')).toHaveText('Up to date', { timeout: 90_000 });
    for (const name of ['Back up now', 'Check', 'Remove']) await expect(place.getByRole('button', { name })).toBeVisible();
    await panel.getByRole('button', { name: 'Manage file servers' }).click();
    await expect(place.getByRole('checkbox', { name: 'Save backups', exact: true })).toBeChecked();
    await panel.getByRole('textbox', { name: 'File server address' }).fill('https://shared-files.test');
    await panel.getByRole('button', { name: 'Add file server' }).click();
    const readOnly = panel.getByRole('listitem', { name: 'shared-files.test' });
    await expect(readOnly.getByRole('checkbox', { name: 'Read files' })).toBeChecked();
    await expect(readOnly.getByRole('checkbox', { name: 'Save backups', exact: true })).not.toBeChecked();
    await panel.screenshot({ path: testInfo.outputPath('backup-file-servers-mobile.png') });
    await expectNoJargon(page);
    const box = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(box.scroll).toBeLessThanOrEqual(box.view);
  });
});
