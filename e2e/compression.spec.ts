import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, goToTreeList, navigateToPublicFolder, openFolderMenu, setupPageErrorHandler, uploadFilesInput } from './test-utils';

// Downloading a folder as a ZIP is covered by file-sharing-journey.
test.describe('forking and extracting', () => {
  test.setTimeout(120_000);

  test('a folder is forked as a new top-level folder, and again under a free name', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Fork Test');
    await createAndEnterFolder(page, 'Plans');
    const folderUrl = page.url();
    const dialog = page.locator('.fixed.inset-0').filter({ hasText: 'Fork as New Folder' });
    const fork = async () => {
      await openFolderMenu(page);
      await page.getByRole('button', { name: 'Fork' }).click();
      await expect(dialog).toBeVisible();
    };

    await fork();
    await expect(dialog.locator('input#fork-name')).toHaveValue('Plans');
    await expect(dialog.getByRole('button', { name: 'public' })).toHaveClass(/ring-accent/);
    await dialog.getByRole('button', { name: 'Fork' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/Plans$/);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible({ timeout: 30_000 });

    // The name is taken now, so the next fork offers another rather than replacing it.
    await page.goto(folderUrl);
    await fork();
    await expect(dialog.locator('input#fork-name')).toHaveValue('Plans-2');
    await dialog.getByRole('button', { name: 'Fork' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/Plans-2$/);
  });

  // Visibility applies to the trees of a plain key; a Drive profile keeps its folders private.
  test('a plain key\'s folder is forked link-visible, with its link key in the address', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await navigateToPublicFolder(page, { requireRelay: false });
    await goToTreeList(page);
    await createAndEnterFolder(page, 'Shared plans');
    await openFolderMenu(page);
    await page.getByRole('button', { name: 'Fork' }).click();
    const dialog = page.locator('.fixed.inset-0').filter({ hasText: 'Fork as New Folder' });
    await dialog.getByRole('button', { name: 'link-visible' }).click();
    await dialog.getByRole('button', { name: 'Fork' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/Shared%20plans\?k=[0-9a-f]+$/);
  });

  test('a ZIP file added to a folder offers to extract, and its files land beside it', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Extract Test');
    await uploadFilesInput(page).setInputFiles({
      name: 'dosgame.zip',
      mimeType: 'application/zip',
      buffer: fs.readFileSync(path.join(process.cwd(), 'test-data', 'dosgame.zip')),
    });
    await expect(page.getByText('Extract Archive?')).toBeVisible({ timeout: 30_000 });
    await page.locator('input[name="extract-location"]').last().check();
    await page.getByRole('button', { name: 'Extract Files' }).click();
    await expect(page.getByText('writing...', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('file-list').getByRole('link').filter({ hasNotText: 'dosgame.zip' }).first()).toBeVisible({ timeout: 30_000 });
  });
});
