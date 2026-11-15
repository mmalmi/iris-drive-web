// Two browsers linked to one account each show, under Storage, both devices:
// whether they are in sync and how much of the Drive each holds, from the
// reports the devices send each other. The second browser has the Drive's
// folders but has not opened the file, so it does not hold all of it; once
// it has, opened afresh on Storage it measures again and holds all of it.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable, fileRow } from './test-utils';

const FILE = { name: 'trip-notes.txt', line: 'Notes from the trip, written on the first device. ' };

async function requestLink(page: Page): Promise<string> {
  await page.goto(`${new URL(page.url()).origin}/#/users`);
  await page.getByTestId('add-existing-profile').click();
  await expect(page.getByTestId('device-approval-qr')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:drive:pending-device-approval') ?? 'null') as { url?: string } | null;
    return stored?.url ?? '';
  });
}

async function openStorage(page: Page): Promise<void> {
  await page.goto(`${new URL(page.url()).origin}/#/settings/storage`);
  await expect(page.getByTestId('device-storage')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('device-storage-row')).toHaveCount(2, { timeout: 60_000 });
}

function row(page: Page, current: boolean) {
  return page.getByTestId('device-storage-row').filter(current ? { hasText: 'This device' } : { hasNotText: 'This device' });
}

test('each device sees how much of the Drive the other holds, and that they are in sync', async ({ page, browser, relayUrl }, testInfo) => {
  test.setTimeout(300_000);
  await prepareFreshSession(page, relayUrl);
  const { profileId } = await createDriveProfile(page, 'Storage Devices');
  await expectFolderEditable(page);
  // A name never used before, so the file server has no copy from an earlier run.
  await page.getByTestId('upload-files-input').setInputFiles([{
    name: FILE.name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`${Date.now()}\n${FILE.line.repeat(4000)}`),
  }]);
  await expect(fileRow(page, FILE.name)).toBeVisible({ timeout: 60_000 });

  const secondContext = await browser.newContext();
  try {
    const second = await secondContext.newPage();
    for (const [name, at] of [['first', page], ['second', second]] as const) {
      at.on('console', (message) => {
        if (message.text().includes('deviceStorage')) console.log(`${name}:`, message.text().slice(0, 300));
      });
    }
    await prepareFreshSession(second, relayUrl);
    const approvalUrl = await requestLink(second);
    await page.goto(`${new URL(page.url()).origin}/#/settings/user`);
    await page.getByTestId('device-approval-input').fill(approvalUrl);
    await page.getByTestId('approve-device-request').click();
    await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 60_000 });
    await expect.poll(() => second.evaluate(() => JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null')?.profileId ?? null), { timeout: 60_000 })
      .toBe(profileId);
    // The second browser shows the Drive, so it has its folders, but never opens the file.
    await second.goto(`${new URL(second.url()).origin}/#/`);
    await expect(fileRow(second, FILE.name)).toBeVisible({ timeout: 90_000 });

    await openStorage(page);
    await openStorage(second);

    // The first browser added the file: it holds all of the Drive.
    await expect(row(page, true).getByTestId('device-storage-held')).toHaveText('All of it', { timeout: 60_000 });
    await expect(page.getByTestId('device-storage-summary')).toContainText('All of it is on this device.');
    // The second has said how much it holds: not the file it never opened.
    const other = row(page, false);
    await expect(other.getByTestId('device-storage-held')).not.toHaveText('No report yet', { timeout: 90_000 });
    await expect(other.getByTestId('device-storage-held')).not.toHaveText('All of it');
    await expect(other.getByTestId('device-storage-sync')).toHaveText('In sync', { timeout: 90_000 });
    await expect(other.getByTestId('device-storage-space')).toContainText(/Uses .+ of .+ allowed/);

    // On the second, the first holds all of it; the row opens to the folders.
    const first = row(second, false);
    await expect(first.getByTestId('device-storage-held')).toHaveText('All of it', { timeout: 90_000 });
    await expect(first.getByTestId('device-storage-sync')).toHaveText('In sync', { timeout: 90_000 });
    await expect(row(second, true).getByTestId('device-storage-held')).not.toHaveText('All of it');
    await first.getByRole('button').first().click();
    await expect(first.getByTestId('device-storage-folders')).toContainText('1 file not in a folder');
    await page.screenshot({ path: testInfo.outputPath('first-device.png'), fullPage: true });
    await second.screenshot({ path: testInfo.outputPath('second-device.png'), fullPage: true });

    // The second opens the file, then the app afresh on Storage: it now holds all of it.
    await second.goto(`${new URL(second.url()).origin}/#/`);
    await fileRow(second, FILE.name).dblclick();
    await expect(second.getByText(FILE.line.trim()).first()).toBeVisible({ timeout: 60_000 });
    await second.getByTestId('viewer-back').click();
    await second.goto(`${new URL(second.url()).origin}/#/settings/storage`);
    await second.reload();
    await expect(row(second, true).getByTestId('device-storage-held')).toHaveText('All of it', { timeout: 60_000 });
    await expect(second.getByTestId('device-storage-summary')).toContainText('All of it is on 2 devices.');
    await expect(row(page, false).getByTestId('device-storage-held')).toHaveText('All of it', { timeout: 90_000 });

    // In the dark and at phone width, with a row open.
    await second.emulateMedia({ colorScheme: 'dark' });
    await second.setViewportSize({ width: 390, height: 844 });
    await row(second, false).getByRole('button').first().click();
    await expect(row(second, false).getByTestId('device-storage-folders')).toBeVisible();
    await second.getByTestId('device-storage').scrollIntoViewIfNeeded();
    await second.waitForTimeout(300);
    await second.screenshot({ path: testInfo.outputPath('second-dark-phone.png') });
  } finally {
    await secondContext.close();
  }
});
