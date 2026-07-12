/**
 * E2E test for folder deletion
 *
 * Tests that deleting a folder removes it from the parent and stays deleted.
 */
import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, goToTreeList, disableOthersPool, waitForAppReady, safeGoto, safeReload } from './test-utils.js';

test.describe('Folder Deletion', () => {
  test('deleted folder should not reappear in its parent', { timeout: 60000 }, async ({ page }) => {
    test.slow();
    setupPageErrorHandler(page);

    await safeGoto(page, '/', { retries: 4, delayMs: 1500 });
    await disableOthersPool(page);
    await goToTreeList(page);

    const folderName = `delete-test-${Date.now()}`;
    await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'New Folder' }).click();
    await page.locator('input[placeholder="Folder name..."]').fill(folderName);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

    const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: folderName }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page.waitForURL(new RegExp(encodeURIComponent(folderName)), { timeout: 15000 });
    await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });

    const deleteBtn = page.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    page.once('dialog', dialog => dialog.accept());

    await deleteBtn.click();
    await page.waitForURL(/\/main(?:\?.*)?$/, { timeout: 10000 });
    await expect(page.locator('[data-testid="file-list"]').first()).toBeVisible({ timeout: 10000 });

    const deletedFolder = page.getByRole('link', { name: folderName });
    await expect(deletedFolder).toHaveCount(0, { timeout: 15000 });

    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000, retries: 3 });
    await waitForAppReady(page, 30000);
    await expect(deletedFolder).toHaveCount(0, { timeout: 15000 });
  });

  test('delete button should be visible at tree root', { timeout: 60000 }, async ({ page }) => {
    test.setTimeout(90000);
    setupPageErrorHandler(page);
    await safeGoto(page, '/', { retries: 4, delayMs: 1500 });
    await disableOthersPool(page);

    // Page ready - navigateToPublicFolder handles waiting

    // Navigate to the public folder (default tree)
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    // Debug: take screenshot
    await page.screenshot({ path: 'test-results/delete-btn-debug.png', fullPage: true });

    // At root of tree, should see Delete button in FolderActions
    // The button is within the folder actions toolbar
    const deleteBtn = page.getByRole('button', { name: 'Delete' }).first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });

    // The delete button should exist at root level
    console.log('Delete button visible at tree root');
  });
});
