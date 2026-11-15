// Deleting asks nothing and says what went, as Google Drive does, with Undo
// for a while: that puts it back as it was, with what was inside it and the
// link that showed it to anyone.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, expectFolderEditable, fileRow, openFolderMenu, openListedFile, openRowMenu, uploadIntoFolder } from './test-utils';

const text = (name: string, body: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
const undo = (page: Page) => page.getByTestId('toast-action').filter({ hasText: 'Undo' });

test.describe('deleting', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('offers Undo, which puts back a file, and a folder with what is in it', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Undoer');
    await expectFolderEditable(page);
    await uploadIntoFolder(page, text('notes.txt', 'Buy bread'));

    const prompts: string[] = [];
    page.on('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'notes.txt')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Deleted “notes.txt”')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('undo-toast.png') });
    await undo(page).click();
    await expect(fileRow(page, 'notes.txt')).toBeVisible({ timeout: 30_000 });
    await expect(undo(page)).toHaveCount(0);
    await openListedFile(page, 'notes.txt');
    await expect(page.locator('pre')).toContainText('Buy bread', { timeout: 30_000 });

    // The open folder: back to the one it was in, and Undo brings it back whole.
    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    await createAndEnterFolder(page, 'Trip');
    await uploadIntoFolder(page, text('plan.txt', 'Day one'));
    await openFolderMenu(page);
    await page.getByTestId('delete-folder-btn').click();
    await expect(page).toHaveURL(new RegExp(`/${owner.profileId}/main$`), { timeout: 30_000 });
    await expect(fileRow(page, 'Trip')).toHaveCount(0, { timeout: 30_000 });
    await undo(page).click();
    await expect(fileRow(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await fileRow(page, 'Trip').getByRole('link').dblclick();
    await expect(fileRow(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    expect(prompts).toEqual([]);

    // Kept after a reload, as any change.
    await page.reload();
    await expect(fileRow(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('Undo turns the link of what was deleted back on', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Sharer');
    await expectFolderEditable(page);
    await createAndEnterFolder(page, 'Trip');
    await uploadIntoFolder(page, text('plan.txt', 'Day one'));

    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    await page.getByTestId('share-tab-people').click();
    await page.getByTestId('general-access-select').selectOption('link');
    await page.getByTestId('general-access-link').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');

    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    await (await openRowMenu(page, 'Trip')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'Trip')).toHaveCount(0, { timeout: 30_000 });
    await undo(page).click();
    await fileRow(page, 'Trip').getByRole('link').dblclick({ timeout: 30_000 });
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link', { timeout: 30_000 });

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(`${new URL(visitor.url()).origin}/#${link.split('#')[1]}`);
      await expect(async () => {
        await visitor.reload();
        await expect(fileRow(visitor, 'plan.txt')).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 90_000 });
    } finally {
      await visitorContext.close();
    }
  });
});
