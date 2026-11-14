import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, goToTreeList, navigateToPublicFolder, openFolderMenu, setupPageErrorHandler, uploadFilesInput } from './test-utils';

// Downloading a folder as a ZIP is covered by file-sharing-journey.
test.describe('forking and extracting', () => {
  test.setTimeout(120_000);

  test('in My Drive a folder is copied beside itself, and again under a free name', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Copy Test');
    await createAndEnterFolder(page, 'Plans');
    await uploadFilesInput(page).setInputFiles({ name: 'goals.txt', mimeType: 'text/plain', buffer: Buffer.from('ship it') });
    await expect(page.getByTestId('file-list').getByRole('link', { name: /^goals\.txt/ })).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main/Plans$`));
    const makeCopy = async () => {
      await openFolderMenu(page);
      await expect(page.getByRole('menuitem', { name: 'Fork' })).toHaveCount(0);
      await page.getByTestId('make-copy-btn').click();
    };
    const listed = (name: string) => page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name}(\\s|$)`) });

    await makeCopy();
    await expect(page.getByText('Made “Copy of Plans”')).toBeVisible({ timeout: 30_000 });
    await makeCopy();
    await expect(page.getByText('Made “Copy of Plans (2)”')).toBeVisible({ timeout: 30_000 });

    await page.goto(`/#/${profileId}/main`);
    await page.reload();
    for (const name of ['Plans', 'Copy of Plans', 'Copy of Plans \\(2\\)']) {
      await expect(listed(name).first()).toBeVisible({ timeout: 30_000 });
    }
    // The copy holds what the folder held, and changes apart from it.
    await listed('Copy of Plans').first().click();
    await expect(listed('goals.txt').first()).toBeVisible({ timeout: 30_000 });
    await uploadFilesInput(page).setInputFiles({ name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('only here') });
    await expect(listed('extra.txt')).toBeVisible({ timeout: 30_000 });
    await page.goto(`/#/${profileId}/main/Plans`);
    await expect(listed('goals.txt').first()).toBeVisible({ timeout: 30_000 });
    await expect(listed('extra.txt')).toHaveCount(0);
  });

  // Visibility applies to the trees of a plain key; a Drive profile keeps its folders private.
  test('a plain key\'s folder is forked link-visible, with its link key in the address', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await navigateToPublicFolder(page, { requireRelay: false });
    await goToTreeList(page);
    await createAndEnterFolder(page, 'Shared plans');
    await openFolderMenu(page);
    await page.getByRole('menuitem', { name: 'Fork' }).click();
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
