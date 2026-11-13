import { saveTextFile } from './test-utils.js';
import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, goToTreeList, safeReload, waitForAppReady } from './test-utils.js';

// Helper to create tree and navigate into it
async function createAndEnterTree(page: any, name: string) {
  await goToTreeList(page);
  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.locator('input[placeholder="Folder name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });
}

test.describe('LIVE Indicator', () => {
  test.setTimeout(180000);

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');

    // Clear storage for fresh state
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (db.name) indexedDB.deleteDatabase(db.name);
      }
      localStorage.clear();
      sessionStorage.clear();
    });

    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page, 60000);
    // Page ready - skip relay requirement for local-only operations
    await navigateToPublicFolder(page, { requireRelay: false });
  });

  test('a text file that was just saved is not labelled LIVE', async ({ page }) => {
    // Create tree with file
    await createAndEnterTree(page, 'live-test');

    // Create file - after clicking Done, it should auto-navigate to the file
    await page.getByRole('button', { name: /File/ }).first().click();
    await page.locator('input[placeholder="File name..."]').fill('test.txt');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.locator('textarea').fill('Hello World');
    await saveTextFile(page);
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Done' }).click();

    // LIVE marks a recording that is still growing, not a saved note.
    await expect(page.getByTestId('viewer-header')).toContainText('test.txt');
    await expect(page.locator('.animate-pulse:has-text("LIVE")')).toHaveCount(0);
  });
});
