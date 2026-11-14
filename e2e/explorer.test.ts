import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseFileAction, chooseNew, createAndEnterFolder, createTextFile, openFolderMenu, saveTextFile } from './test-utils';

function listed(page: Page, name: string) {
  return page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name.replace(/\./g, '\\.')}(\\s|$)`) });
}

async function startInFolder(page: Page, relayUrl: string, folder: string): Promise<void> {
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Files Test');
  await createAndEnterFolder(page, folder);
}

test.describe('files and folders in My Drive', () => {
  test.setTimeout(150_000);

  test('a text file is written, viewed, edited, and keeps its text after going elsewhere', async ({ page, relayUrl }) => {
    await startInFolder(page, relayUrl, 'Notes');
    await createTextFile(page, 'empty.txt');
    await createTextFile(page, 'hello.txt', 'Hello, World!');

    await listed(page, 'empty.txt').click();
    await expect(page.getByTestId('viewer-header')).toContainText('empty.txt', { timeout: 30_000 });
    await expect(page.locator('pre')).toHaveCount(1);

    await listed(page, 'hello.txt').click();
    await expect(page.locator('pre')).toContainText('Hello, World!', { timeout: 30_000 });
    await chooseFileAction(page, 'viewer-edit');
    await expect(page.locator('textarea')).toHaveValue('Hello, World!');
    await page.locator('textarea').fill('Updated content');
    await saveTextFile(page);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('pre')).toContainText('Updated content');

    // Leaving with changes not saved asks first; Don't Save keeps the saved text.
    await chooseFileAction(page, 'viewer-edit');
    await page.locator('textarea').fill('This will be dropped');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible();
    await page.getByRole('button', { name: "Don't Save" }).click();
    await expect(page.locator('pre')).toContainText('Updated content');

    const fileUrl = page.url();
    await page.getByTestId('home-link').click();
    await page.goto(fileUrl);
    await page.reload();
    await expect(page.locator('pre')).toContainText('Updated content', { timeout: 30_000 });

    // The New dialog closes from outside it.
    await page.getByTestId('viewer-back').click();
    await chooseNew(page, 'Text file');
    await expect(page.getByPlaceholder('File name...')).toBeVisible();
    await page.locator('div.fixed.inset-0.bg-black\\/70').click({ position: { x: 10, y: 10 } });
    await expect(page.getByPlaceholder('File name...')).toBeHidden();
  });

  test('files and folders are renamed and deleted, and stay that way after a reload', async ({ page, relayUrl }) => {
    await startInFolder(page, relayUrl, 'Work');
    const folderUrl = page.url();
    await createTextFile(page, 'old-name.txt', 'rename me');
    await createTextFile(page, 'to-delete.txt', 'delete me');
    await createAndEnterFolder(page, 'old-folder');

    // A folder's menu renames and deletes it.
    await openFolderMenu(page);
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await expect(page.getByPlaceholder('New name...')).toHaveValue('old-folder');
    await page.getByPlaceholder('New name...').fill('new-folder');
    await page.getByPlaceholder('New name...').press('Enter');
    await expect(page).toHaveURL(/\/Work\/new-folder$/);
    await openFolderMenu(page);
    await page.getByTestId('delete-folder-btn').click();
    await expect(page).toHaveURL(folderUrl);

    // A file's own buttons rename and delete it.
    await listed(page, 'old-name.txt').click();
    await chooseFileAction(page, 'viewer-rename');
    await page.getByPlaceholder('New name...').fill('new-name.txt');
    await page.getByPlaceholder('New name...').press('Enter');
    await expect(listed(page, 'new-name.txt')).toBeVisible({ timeout: 30_000 });
    await listed(page, 'to-delete.txt').click();
    await chooseFileAction(page, 'viewer-delete');
    await expect(listed(page, 'to-delete.txt')).toHaveCount(0);

    await page.goto(folderUrl);
    await page.reload();
    await expect(listed(page, 'new-name.txt')).toBeVisible({ timeout: 30_000 });
    for (const gone of ['old-name.txt', 'to-delete.txt', 'old-folder', 'new-folder']) {
      await expect(listed(page, gone)).toHaveCount(0);
    }

    // My Drive itself has no name to change.
    await page.getByTestId('home-link').click();
    await openFolderMenu(page);
    await expect(page.getByTestId('folder-menu').getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
  });
});
