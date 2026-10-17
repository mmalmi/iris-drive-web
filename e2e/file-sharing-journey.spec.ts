import fs from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { test, expect, type Page } from './fixtures';
import {
  configureBlossomServers,
  presetLocalRelayInDB,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

// Keep real onboarding and readonly guests; only redirect network services locally.
async function prepare(page: Page, relayUrl: string, hostname?: string) {
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('/');
  if (hostname) {
    const url = new URL(page.url());
    url.hostname = hostname;
    await page.goto(url.origin);
  }
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload();
  await waitForAppReady(page);
  await configureBlossomServers(page);
  await waitForRelayConnected(page);
}

async function createProfile(page: Page) {
  await page.getByTestId('generate-new-account').click();
  await page.getByTestId('identity-create-name').fill('Alice');
  await page.getByTestId('create-new-after-recovery-miss').click();
  await expect(page.locator('label[title="Add files"]:visible')).toBeVisible();
}

async function upload(page: Page, name: string, buffer: Buffer) {
  await page.locator('label[title="Add files"]:visible input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.getByTestId('viewer-header')).toContainText(name);
}

async function copyShare(page: Page, file = true) {
  await (file ? page.getByTestId('viewer-share') : page.getByRole('button', { name: 'Share', exact: true })).click();
  await page.getByTestId('share-copy-url').click();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/^https:\/\/drive\.iris\.to\/#\/nhash1/);
  await page.keyboard.press('Escape');
  return new URL(url).hash;
}

async function downloadedBytes(page: Page, button: ReturnType<Page['getByTestId']>) {
  const pending = page.waitForEvent('download');
  await button.click();
  const download = await pending;
  const path = await download.path();
  expect(path).not.toBeNull();
  return { name: download.suggestedFilename(), bytes: await fs.readFile(path!) };
}

test.describe('basic file-sharing journeys', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test.setTimeout(120_000);

  test('a guest opens, reloads and downloads a shared file without receiving its private sibling', async ({ page, browser, relayUrl }, testInfo) => {
    await prepare(page, relayUrl);
    await createProfile(page);
    await upload(page, 'private-notes.txt', Buffer.from('Only Alice should see this.'));
    await page.getByTestId('viewer-back').click();
    const name = 'Picnic café & photos.bin';
    const bytes = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 12)) % 256;
    await upload(page, name, bytes);
    const hash = await copyShare(page);
    await page.screenshot({ path: testInfo.outputPath('owner-file.png') });

    const context = await browser.newContext();
    try {
      const guest = await context.newPage();
      await prepare(guest, relayUrl);
      await guest.goto(`/${hash}`);
      await expect(guest.getByTestId('viewer-header')).toContainText(name);
      await expect(guest.getByText('private-notes.txt')).toHaveCount(0);
      expect(await guest.evaluate(() => localStorage.getItem('iris:identity:session'))).toBeNull();
      await expect(guest.getByTestId('viewer-edit')).toHaveCount(0);
      await expect(guest.getByTestId('viewer-rename')).toHaveCount(0);
      await expect(guest.getByTestId('viewer-delete')).toHaveCount(0);
      const downloaded = await downloadedBytes(guest, guest.getByTestId('viewer-download'));
      expect(downloaded.name).toBe(name);
      expect(downloaded.bytes.equals(bytes)).toBe(true);
      await page.goto('about:blank');
      await guest.reload();
      await expect(guest.getByTestId('viewer-header')).toContainText(name);
      await guest.screenshot({ path: testInfo.outputPath('guest-file.png') });
      const again = await downloadedBytes(guest, guest.getByTestId('viewer-download'));
      expect(again.bytes.equals(bytes)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('a guest browses a shared folder and downloads its files as a ZIP', async ({ page, browser, relayUrl }, testInfo) => {
    await prepare(page, relayUrl);
    await createProfile(page);
    await upload(page, 'private-notes.txt', Buffer.from('Outside the shared folder.'));
    await page.getByTestId('viewer-back').click();
    await page.getByRole('button', { name: 'New Folder', exact: true }).click();
    await page.getByPlaceholder('Folder name...').fill('Weekend picnic');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('link', { name: 'Weekend picnic', exact: true }).click();
    await expect(page.getByText('Empty directory', { exact: true })).toBeVisible();
    await upload(page, 'Plan.txt', Buffer.from('Meet by the lake at noon.'));
    await page.getByTestId('viewer-back').click();
    await upload(page, 'Snacks.txt', Buffer.from('Bring strawberries.'));
    await page.getByTestId('viewer-back').click();
    const hash = await copyShare(page, false);
    await page.screenshot({ path: testInfo.outputPath('owner-folder.png') });

    const context = await browser.newContext();
    try {
      const guest = await context.newPage();
      await prepare(guest, relayUrl);
      await guest.goto(`/${hash}`);
      await expect(guest.getByRole('link', { name: /Plan.txt/ })).toBeVisible();
      await expect(guest.getByText('private-notes.txt')).toHaveCount(0);
      await expect(guest.getByRole('button', { name: 'New File', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
      await guest.getByRole('link', { name: /Plan.txt/ }).click();
      await expect(guest.getByText('Meet by the lake at noon.', { exact: true })).toBeVisible();
      await guest.goto(`${guest.url()}?edit=1`);
      await expect(guest.locator('textarea')).toHaveCount(0);
      await guest.setViewportSize({ width: 390, height: 844 });
      await guest.getByRole('button', { name: 'Next: Snacks.txt', exact: true }).click();
      await expect(guest.getByText('Bring strawberries.', { exact: true })).toBeVisible();
      await guest.getByRole('button', { name: 'Previous: Plan.txt', exact: true }).click();
      await expect(guest.getByText('Meet by the lake at noon.', { exact: true })).toBeVisible();
      await expect(guest.getByTestId('viewer-back')).toHaveAttribute('href', hash);
      await guest.getByTestId('viewer-back').click();
      const download = await downloadedBytes(guest, guest.getByRole('button', { name: 'ZIP', exact: true }));
      const files = unzipSync(download.bytes);
      expect(Object.keys(files).sort()).toEqual(['Plan.txt', 'Snacks.txt']);
      expect(new TextDecoder().decode(files['Plan.txt'])).toBe('Meet by the lake at noon.');
      expect(new TextDecoder().decode(files['Snacks.txt'])).toBe('Bring strawberries.');
      await guest.screenshot({ path: testInfo.outputPath('guest-folder-mobile.png') });
    } finally {
      await context.close();
    }
  });

  test('a signed native invitation cannot be accepted under a different profile', async ({ page, relayUrl }, testInfo) => {
    // A hosted browser does not have the native gateway assumed for localhost.
    await prepare(page, relayUrl, 'drive.localhost');
    await createProfile(page);
    const nativeInvite = JSON.parse(await fs.readFile(new URL('../tests/fixtures/native-share-invite.json', import.meta.url), 'utf8'));
    const payload = Buffer.from(JSON.stringify(nativeInvite)).toString('base64url');
    await page.goto(`${new URL(page.url()).origin}/#/share-invite/${payload}`);
    await expect(page.getByTestId('share-invite-accept')).toBeVisible();
    await page.getByTestId('share-invite-accept').click();
    await expect(page.getByText('This invite is for another profile. Switch profiles to accept it.')).toBeVisible();
    await expect(page.getByText('Accepted', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('wrong-recipient.png') });
    await page.getByTestId('home-link').click();
    await page.getByRole('link', { name: 'Shared with me', exact: true }).click();
    await expect(page.getByTestId('shared-with-me-row')).toHaveCount(0);
  });
});
