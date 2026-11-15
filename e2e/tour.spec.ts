// Walks through the app as a user would. With LAYOUT_SHOTS_DIR set it saves a
// screenshot of every view at a desktop and a phone size (LAYOUT_LIGHT=1 for light).
import { expect, test, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';
import { chooseFileAction, chooseNew } from './test-utils';

const dir = process.env.LAYOUT_SHOTS_DIR;
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function shot(page: Page, name: string): Promise<void> {
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/${name}-d.png` });
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/${name}-m.png` });
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(150);
}

// One broken view should not hide the ones after it: each is tried, and the
// test fails at the end with the list of those that did not work.
const failures: string[] = [];

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(`${name}: ${String(error).split('\n')[0]}`);
  }
}

async function inviteLink(page: Page, role: 'editor' | 'reader' = 'editor'): Promise<string> {
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
  const create = page.getByTestId('share-people-create');
  await expect(create.or(page.getByTestId('share-people-link'))).toBeVisible({ timeout: 30_000 });
  if (await create.isVisible()) await create.click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-role').selectOption(role);
  await page.getByTestId('share-people-link').click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe('a walk through the app', () => {
  test.setTimeout(600_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('every view opens and the ways between them work', async ({ page, browser, relayUrl }) => {
    await page.emulateMedia({ colorScheme: process.env.LAYOUT_LIGHT ? 'light' : 'dark' });
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    await shot(page, '01-setup');
    await step('name step', async () => {
      await page.getByTestId('generate-new-account').click();
      await expect(page.getByTestId('identity-create-name')).toBeVisible({ timeout: 30_000 });
      await shot(page, '02-setup-name');
      await page.goto('/', { waitUntil: 'domcontentloaded' });
    });
    const owner = await createDriveProfile(page, 'Liminal Forest');
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });
    const origin = new URL(page.url()).origin;
    await expect(page.getByTestId('folder-header').getByRole('heading', { name: 'My Drive' })).toBeVisible();
    await shot(page, '03-drive-empty');

    await step('sidebar new', async () => {
      await page.getByTestId('drive-sidebar').getByRole('button', { name: 'New', exact: true }).click();
      await shot(page, '04-new-menu');
      await page.keyboard.press('Escape');
    });

    await step('content', async () => {
      await chooseNew(page, 'Folder');
      await page.getByPlaceholder('Folder name...').fill('Trip photos');
      await page.getByPlaceholder('Folder name...').press('Enter');
      await expect(page.getByTestId('file-list').getByRole('link', { name: 'Trip photos' })).toBeVisible();
      await page.getByTestId('upload-files-input').setInputFiles([
        { name: 'packing list.txt', mimeType: 'text/plain', buffer: Buffer.from('Tent\nMaps\nStove\n') },
        { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nMeet by the **lake** at noon.\n\n- one\n- two\n') },
        { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUUlEQVR4nO3PQQ0AIBDAMMC/5+ONAvZoFSzZnplV1uoAgA4AaAeAdgBoB4B2AGgHgHYAaAeAdgBoB4B2AGgHgHYAaAeAdgBoB4B2AGgHgNYBFscCfdwmhjwAAAAASUVORK5CYII=', 'base64') },
      ]);
      await expect(page.getByTestId('file-list').getByRole('link', { name: /pixel\.png/ })).toBeVisible({ timeout: 30_000 });
      await page.goto(`${origin}/#/${owner.profileId}/main`);
    });
    await createDocument(page, 'Trip plan');
    await typeInDocument(page, 'Pack the tent and buy maps.');
    await expectSaved(page);
    await shot(page, '05-document');
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByTestId('document-entry').filter({ visible: true })).toHaveCount(1);
    await shot(page, '06-drive-list');

    await step('folder menu', async () => {
      await page.getByTestId('folder-menu-btn').filter({ visible: true }).click();
      await shot(page, '07-folder-menu');
      await page.keyboard.press('Escape');
    });

    await step('text file', async () => {
      await page.getByTestId('file-list').getByRole('link', { name: /packing list\.txt/ }).dblclick();
      await expect(page.getByTestId('viewer-header')).toContainText('packing list.txt', { timeout: 30_000 });
      await shot(page, '08-file-text');
      await chooseFileAction(page, 'viewer-edit');
      await shot(page, '09-file-edit');
      await page.goto(`${origin}/#/${owner.profileId}/main`);
    });
    await step('markdown file', async () => {
      await page.getByTestId('file-list').getByRole('link', { name: /notes\.md/ }).dblclick();
      await expect(page.getByTestId('viewer-header')).toContainText('notes.md', { timeout: 30_000 });
      await shot(page, '10-file-markdown');
      await page.goto(`${origin}/#/${owner.profileId}/main`);
    });
    await step('image file', async () => {
      await page.getByTestId('file-list').getByRole('link', { name: /pixel\.png/ }).dblclick();
      await expect(page.getByTestId('viewer-header')).toContainText('pixel.png', { timeout: 30_000 });
      await shot(page, '11-file-image');
      await page.goto(`${origin}/#/${owner.profileId}/main`);
    });
    await step('subfolder', async () => {
      await page.getByTestId('file-list').getByRole('link', { name: 'Trip photos' }).dblclick();
      await expect(page.getByTestId('folder-header').getByRole('heading', { name: 'Trip photos' })).toBeVisible();
      await shot(page, '12-subfolder-empty');
      await page.goto(`${origin}/#/${owner.profileId}/main`);
    });
    await step('folder share modal', async () => {
      await page.getByTitle('Share').filter({ visible: true }).first().click();
      await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
      await shot(page, '13-share-modal-link');
      await page.keyboard.press('Escape');
    });
    await step('search', async () => {
      await page.getByPlaceholder('Search').first().fill('trip');
      await shot(page, '14-search');
      await page.getByPlaceholder('Search').first().fill('');
      await page.keyboard.press('Escape');
    });
    await step('recent', async () => {
      await page.goto(`${origin}/#/recent`);
      await shot(page, '15-recent');
    });
    await step('account menu', async () => {
      await page.getByTestId('header-user-avatar').click();
      await expect(page.getByTestId('account-menu')).toBeVisible();
      await shot(page, '16-account-menu');
      await page.keyboard.press('Escape');
      // A phone has no sidebar: its places are tabs along the bottom.
      await page.setViewportSize(PHONE);
      try {
        await page.getByTestId('drive-tabs').getByRole('link', { name: 'Shared with me' }).click();
        await expect(page.getByTestId('shared-with-me-view')).toBeVisible();
        await shot(page, '16b-phone-tabs');
      } finally {
        await page.setViewportSize(DESKTOP);
      }
    });
    for (const tab of ['', '/storage', '/about', '/network', '/keys', '/developer']) {
      await step(`settings${tab}`, async () => {
        await page.goto(`${origin}/#/settings${tab}`);
        await page.waitForTimeout(1200);
        await shot(page, `17-settings${tab.replace('/', '-') || '-account'}`);
      });
    }
    await step('users', async () => {
      await page.goto(`${origin}/#/users`);
      await page.waitForTimeout(800);
      await shot(page, '18-users');
    });
    await step('profile tree list', async () => {
      await page.goto(`${origin}/#/${owner.profileId}`);
      await page.waitForTimeout(800);
      await shot(page, '19-profile-root');
    });

    // Share the document by link and look at it from both sides.
    let link = '';
    await step('share document', async () => {
      await page.goto(`${origin}/#/${owner.profileId}/main`);
      await page.getByTestId('document-entry').filter({ visible: true }).first().dblclick();
      await expect(page.getByTestId('document-title')).toHaveText('Trip plan', { timeout: 30_000 });
      await page.getByTestId('document-share').click();
      link = await inviteLink(page);
      await shot(page, '20-share-people');
      await page.keyboard.press('Escape');
      await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 30_000 });
    });
    await step('owner shared with me', async () => {
      await page.goto(`${origin}/#/shared-with-me`);
      await page.waitForTimeout(800);
      await shot(page, '21-shared-with-me-owner');
    });

    if (link) {
      const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      const guest = await guestContext.newPage();
      await guest.emulateMedia({ colorScheme: process.env.LAYOUT_LIGHT ? 'light' : 'dark' });
      await guest.setViewportSize(DESKTOP);
      await step('guest without account', async () => {
        await prepareFreshSession(guest, relayUrl);
        await guest.goto(`${origin}/#${link.split('#')[1]}`);
        await guest.waitForTimeout(1500);
        await shot(guest, '22-join-no-account');
        await createDriveProfile(guest, 'Guest Reader');
        await expect(guest.getByTestId('document-content')).toBeVisible({ timeout: 90_000 });
        await shot(guest, '23-guest-document');
        await guest.goto(`${origin}/#/shared-with-me`);
        await guest.waitForTimeout(800);
        await shot(guest, '24-shared-with-me-guest');
        await guest.getByTestId('shared-with-me-row').first().click();
        await expect(guest.getByTestId('folder-header').getByRole('heading', { name: 'Trip plan' })).toBeVisible({ timeout: 30_000 });
        await expect(guest.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'Shared with me' })).toBeVisible();
        await shot(guest, '25-guest-shared-folder');
      });
      await step('owner shared document', async () => {
        // What the owner shared stays in their My Drive, not in Shared with me.
        await page.goto(`${origin}/#/shared-with-me`);
        await expect(page.getByTestId('shared-with-me-row')).toHaveCount(0);
        await page.goto(`${origin}/#/${owner.profileId}/main`);
        await page.getByTestId('document-entry').filter({ visible: true }).first().dblclick();
        await expect(page.getByTestId('document-title')).toHaveText('Trip plan', { timeout: 30_000 });
        await shot(page, '26-owner-shared-document');
      });
      await guestContext.close();
    }
    expect(failures).toEqual([]);
  });
});
