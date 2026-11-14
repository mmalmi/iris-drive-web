// A read-only copy of a folder opens under the folder's name, not its
// "nhash1…" address, and a page without access belongs to no place in Drive.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, expectFolderEditable, fileRow, openListedFile, openRowMenu, uploadIntoFolder } from './test-utils';

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

test.describe('names and places of pages', () => {
  test.setTimeout(180_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a read-only copy of a folder is titled with the folder name', async ({ page, browser, relayUrl }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await expectFolderEditable(page);
    await createAndEnterFolder(page, 'Weekend picnic');
    await uploadIntoFolder(page, { name: 'Plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Meet at noon.') });

    await page.getByTestId('folder-header').locator('button[title="Share"]').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-copy-url').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/#\/nhash1/);
    await page.keyboard.press('Escape');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await visitor.setViewportSize({ width: 1280, height: 800 });
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      const heading = visitor.getByTestId('folder-header').getByRole('heading');
      await expect(heading).toHaveText('Weekend picnic', { timeout: 60_000 });
      await expect(visitor.getByTestId('folder-header')).not.toContainText('nhash');
      await visitor.screenshot({ path: testInfo.outputPath('read-only-copy.png') });

      // Read-only: a row's menu offers only what does not change anything.
      const menu = await openRowMenu(visitor, 'Plan.txt');
      await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Share', 'Download']);
      await visitor.keyboard.press('Escape');

      // Going into a file and back keeps the name.
      await openListedFile(visitor, 'Plan.txt');
      await visitor.getByTestId('viewer-back').click();
      await expect(heading).toHaveText('Weekend picnic', { timeout: 30_000 });
      await expect(fileRow(visitor, 'Plan.txt')).toBeVisible();
    } finally {
      await visitorContext.close();
    }
  });

  test('nothing in Drive is highlighted on the "You need access" page', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Visitor');
    await expectFolderEditable(page);
    const sidebar = page.getByTestId('drive-sidebar');
    await expect(sidebar.getByRole('link', { name: 'My Drive' })).toHaveAttribute('aria-current', 'page');

    await page.goto(`${new URL(page.url()).origin}/#/9f2c4e1a-7b3d-4c5e-8f6a-1d2e3f4a5b6c/main`);
    await expect(page.getByTestId('no-access')).toContainText('You need access', { timeout: 30_000 });
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('drive-tabs')).toBeVisible();
    await expect(page.getByTestId('drive-tabs').locator('[aria-current="page"]')).toHaveCount(0);
  });
});
