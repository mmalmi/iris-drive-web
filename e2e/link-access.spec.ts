import { expect, test, type Page } from './fixtures';
import { chooseNew, openFileMenu, openFolderMenu } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';

/** General access by link: anyone with the link views the latest version, signed out, until it is turned off. */

function row(page: Page, name: string) {
  return page.getByTestId('file-list').locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function openGeneralAccess(page: Page): Promise<void> {
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('share-tab-people').click();
  await expect(page.getByTestId('general-access')).toBeVisible();
}

async function copiedLink(page: Page): Promise<string> {
  await page.getByTestId('general-access-link').click();
  return page.evaluate(() => navigator.clipboard.readText());
}

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

test.describe('anyone with the link can view', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a folder opens signed out by its link, shows each new version, and stops when turned off', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await row(page, 'Trip').click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Day one') });
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });

    // Restricted until it is changed; then a link to copy.
    await openGeneralAccess(page);
    const select = page.getByTestId('general-access-select');
    await expect(select).toHaveValue('off');
    await expect(page.getByTestId('general-access-link')).toHaveCount(0);
    await select.selectOption('link');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('general-access-on.png') });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/Trip\?k=[0-9a-f]+$/);
    await page.keyboard.press('Escape');
    // Still in My Drive, marked for what it is.
    await expect(page).toHaveURL(/\/main\/Trip$/);
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');
    await expect(page.getByTestId('access-badge')).toHaveText('Anyone with the link');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(row(visitor, 'plan.txt')).toBeVisible({ timeout: 60_000 });
      await expect(visitor.getByTestId('drive-setup')).toHaveCount(0);
      await visitor.screenshot({ path: testInfo.outputPath('visitor.png') });

      // A change in My Drive reaches the same link.
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'tickets.txt', mimeType: 'text/plain', buffer: Buffer.from('Seat 12') });
      await expect(row(page, 'tickets.txt')).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        await visitor.reload();
        await expect(row(visitor, 'tickets.txt')).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      await row(visitor, 'tickets.txt').click();
      await expect(visitor.getByText('Seat 12')).toBeVisible({ timeout: 60_000 });
      // A visitor can look, not change anything.
      await expect(visitor.getByTestId('upload-files-input')).toHaveCount(0);
      const visitorMenu = await openFileMenu(visitor);
      await expect(visitorMenu.getByTestId('viewer-copy')).toBeVisible();
      await expect(visitorMenu.getByTestId('viewer-delete')).toHaveCount(0);
      await visitor.keyboard.press('Escape');

      // Renamed, it keeps its link.
      await page.getByTestId('viewer-back').click().catch(() => {});
      await openFolderMenu(page);
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await page.getByPlaceholder('New name...').fill('Holiday');
      await page.getByPlaceholder('New name...').press('Enter');
      await expect(page).toHaveURL(/\/main\/Holiday$/, { timeout: 30_000 });
      await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');
      await openGeneralAccess(page);
      expect(await copiedLink(page)).toBe(link);

      // Turned off, a new open says the link no longer works, rather than loading for ever.
      await page.getByTestId('general-access-select').selectOption('off');
      await expect(page.getByTestId('general-access-link')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'private');
    } finally {
      await visitorContext.close();
    }

    const laterContext = await browser.newContext();
    try {
      const later = await laterContext.newPage();
      await prepareFreshSession(later, relayUrl);
      await later.goto(onThisOrigin(later, link));
      await expect(later.getByTestId('protected-tree-notice')).toContainText('This link no longer works', { timeout: 60_000 });
      await expect(row(later, 'plan.txt')).toHaveCount(0);
      await expect(later.getByText('Loading...')).toHaveCount(0);
      await later.screenshot({ path: testInfo.outputPath('turned-off.png') });
    } finally {
      await laterContext.close();
    }
  });

  test('a document is shared publicly and opens as a document', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Document');
    await page.getByPlaceholder('Document name...').fill('Notes');
    await page.getByPlaceholder('Document name...').press('Enter');
    await expect(page.getByTestId('document-title')).toHaveText('Notes', { timeout: 30_000 });
    const body = page.getByTestId('document-content').locator('.ProseMirror');
    await body.click();
    await page.keyboard.type('Bring snacks.');
    await expect(page.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('general-access')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('general-access-select').selectOption('public');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/Notes\/Notes\.irisdoc$/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'public');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(visitor.getByTestId('document-content')).toContainText('Bring snacks.', { timeout: 60_000 });
      await expect(visitor.getByTestId('document-toolbar')).toHaveCount(0);
    } finally {
      await visitorContext.close();
    }
  });
});
