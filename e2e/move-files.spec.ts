import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseFileAction, chooseNew, openFolderMenu, openListedFile } from './test-utils';

function row(page: Page, name: string) {
  return page.getByTestId('file-list').locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function makeFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await expect(row(page, name)).toBeVisible({ timeout: 30_000 });
}

async function openFolder(page: Page, name: string): Promise<void> {
  await row(page, name).click();
  await expect(page).toHaveURL(new RegExp(`/${name}$`), { timeout: 30_000 });
  await expect(row(page, name)).toHaveCount(0, { timeout: 30_000 });
}

test.describe('moving files and folders', () => {
  test.setTimeout(120_000);

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('a file is moved into a folder two levels down from its own page', async ({ page, relayUrl }) => {
      await prepareFreshSession(page, relayUrl);
      await createDriveProfile(page, 'Mover');
      await makeFolder(page, 'Inbox');
      await makeFolder(page, 'Archive');
      await openFolder(page, 'Archive');
      await makeFolder(page, '2025');
      await page.getByRole('link', { name: 'Back' }).click();
      await expect(row(page, 'Inbox')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Plant the beans') });
      await openListedFile(page, 'plan.txt');
      await expect(page.getByText('Plant the beans')).toBeVisible({ timeout: 30_000 });

      await chooseFileAction(page, 'viewer-move');
      const dialog = page.getByTestId('move-dialog');
      await expect(dialog.getByTestId('move-here-name')).toHaveText('My Drive');
      // Where it already is cannot be chosen.
      await expect(dialog.getByTestId('move-confirm')).toBeDisabled();
      await expect(dialog.getByTestId('move-folder')).toHaveText(['Archive', 'Inbox']);
      await dialog.getByTestId('move-folder').filter({ hasText: 'Archive' }).click();
      await dialog.getByTestId('move-folder').filter({ hasText: '2025' }).click();
      await expect(dialog.getByTestId('move-here-name')).toHaveText('2025');
      await page.screenshot({ path: test.info().outputPath('move-dialog-phone.png') });
      await dialog.getByTestId('move-confirm').click();

      await expect(page.getByText('Moved plan.txt to 2025')).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/main\/Archive\/2025\/plan\.txt$/, { timeout: 30_000 });
      await expect(page.getByText('Plant the beans')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('viewer-back').click();
      await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('link', { name: 'Back' }).click();
      await page.getByRole('link', { name: 'Back' }).click();
      await expect(row(page, 'Inbox')).toBeVisible({ timeout: 30_000 });
      await expect(row(page, 'plan.txt')).toHaveCount(0);
    });
  });

  test('a folder is moved from its menu, and cannot be moved into itself', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Mover');
    await makeFolder(page, 'Archive');
    await makeFolder(page, 'Inbox');
    await openFolder(page, 'Inbox');
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Inside') });
    await expect(row(page, 'note.txt')).toBeVisible({ timeout: 30_000 });

    await openFolderMenu(page);
    await page.getByTestId('move-folder-btn').click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog.getByTestId('move-folder')).toHaveText(['Archive']);
    await dialog.getByTestId('move-folder').click();
    await dialog.getByTestId('move-confirm').click();

    await expect(page).toHaveURL(/\/main\/Archive\/Inbox$/, { timeout: 30_000 });
    await expect(row(page, 'note.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('a file dragged onto a folder moves into it, unless something there has its name', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Mover');
    await makeFolder(page, 'Archive');
    const upload = async () => {
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Plant the beans') });
      await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    };
    const archive = page.locator('[data-testid="file-row"][data-entry-name="Archive"]');

    await upload();
    await row(page, 'plan.txt').dragTo(archive);
    await expect(page.getByText('Moved plan.txt to Archive')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'plan.txt')).toHaveCount(0, { timeout: 30_000 });

    await upload();
    await row(page, 'plan.txt').dragTo(archive);
    await expect(page.getByText('There is already something called “plan.txt” there')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'plan.txt')).toBeVisible();
  });
});
