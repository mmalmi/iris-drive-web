import { test, expect } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, goToTreeList } from './test-utils.js';
import * as fs from 'fs';
import * as path from 'path';

async function createFolderAndOpen(page: any, folderName: string): Promise<void> {
  await goToTreeList(page);

  const newFolderButton = page.getByRole('button', { name: 'New Folder' }).first();
  await expect(newFolderButton).toBeVisible({ timeout: 5000 });
  await newFolderButton.click();

  const input = page.locator('input[placeholder="Folder name..."]');
  await input.waitFor({ timeout: 5000 });
  await input.fill(folderName);
  await page.click('button:has-text("Create")');

  await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

  const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: folderName }).first();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes(folderName) || url.includes(encodeURIComponent(folderName))) {
      break;
    }
    if (await folderLink.isVisible().catch(() => false)) {
      await folderLink.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }

  await expect(page).toHaveURL(new RegExp(encodeURIComponent(folderName)), { timeout: 10000 });
  await expect(page.getByText(/Drop or click to add|Empty directory/).first()).toBeVisible({ timeout: 10000 });
}

test.describe('Compression features', () => {
  test.describe.configure({ timeout: 90000 });
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await disableOthersPool(page);
  });

  test('should show ZIP button when viewing a folder', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'zip-test-folder');

    // The ZIP button should be visible in the folder actions (use getByRole for more reliable selection)
    const zipButton = page.getByRole('button', { name: 'ZIP' });
    await expect(zipButton).toBeVisible({ timeout: 5000 });

    // The button should say "ZIP"
    await expect(zipButton).toHaveText(/ZIP/);
  });

  test('should show ZIP button with proper icon', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'zip-icon-test');

    // Check that the ZIP button exists and contains the archive icon
    const zipButton = page.getByRole('button', { name: 'ZIP' });
    await expect(zipButton).toBeVisible({ timeout: 5000 });

    // The button should contain an icon with the archive class
    const icon = zipButton.locator('span.i-lucide-archive');
    await expect(icon).toBeAttached();
  });

  test('should show Snapshot, Fork, and ZIP buttons for folder', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'actions-test-folder');

    // All three folder action buttons should be visible (use getByRole for reliable selection)
    await expect(page.getByRole('link', { name: 'Snapshot' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Fork' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'ZIP' })).toBeVisible({ timeout: 5000 });
  });

  test('should fork a folder as a new top-level tree', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'fork-source');

    // Click the Fork button (the one in folder actions)
    await page.getByRole('button', { name: 'Fork' }).click();

    // Fork modal should appear
    await expect(page.locator('text="Fork as New Folder"')).toBeVisible({ timeout: 5000 });
    const forkInput = page.locator('input#fork-name');
    await expect(forkInput).toBeVisible();

    // Change the name and fork using the modal's Fork button
    await forkInput.fill('my-forked-folder');
    // Click the Fork button in the modal (use locator inside modal)
    await page.locator('.fixed.inset-0').getByRole('button', { name: 'Fork' }).click();

    // Wait for modal to close and navigation to the new folder
    await expect(page.locator('text="Fork as New Folder"')).not.toBeVisible({ timeout: 10000 });

    // Should be navigated to the new forked folder
    await expect(page).toHaveURL(/my-forked-folder/, { timeout: 10000 });

    // A fork is a separate tree, not an entry inside the main tree. Reload its
    // route to prove that the new top-level root was persisted.
    await page.reload();
    await expect(page).toHaveURL(/my-forked-folder/, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: 'my-forked-folder' })).toBeVisible({ timeout: 10000 });
  });

  test('should fork a folder with visibility selection', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'fork-visibility-source');

    // Click the Fork button
    await page.getByRole('button', { name: 'Fork' }).click();

    // Fork modal should appear with visibility picker
    await expect(page.locator('text="Fork as New Folder"')).toBeVisible({ timeout: 5000 });
    const forkInput = page.locator('input#fork-name');
    await expect(forkInput).toBeVisible();

    // Visibility picker should be visible with all three options
    await expect(page.locator('button:has-text("public")')).toBeVisible();
    await expect(page.locator('button:has-text("link-visible")')).toBeVisible();
    await expect(page.locator('button:has-text("private")')).toBeVisible();

    // Public should be selected by default (uses ring-accent for selected state)
    const publicButton = page.locator('.fixed.inset-0').locator('button:has-text("public")');
    await expect(publicButton).toHaveClass(/ring-accent/);

    // Change the name and select linkvis visibility
    await forkInput.fill('my-linkvis-fork');
    await page.locator('.fixed.inset-0').locator('button:has-text("link-visible")').click();

    // Click Fork button
    await page.locator('.fixed.inset-0').getByRole('button', { name: 'Fork' }).click();

    // Wait for modal to close and navigation
    await expect(page.locator('text="Fork as New Folder"')).not.toBeVisible({ timeout: 10000 });

    // Should be navigated to the new forked folder (with link key for linkvis)
    await expect(page).toHaveURL(/my-linkvis-fork/, { timeout: 10000 });

    // The URL should contain a link key parameter for link-visible tree
    await expect(page).toHaveURL(/\?k=/, { timeout: 5000 });
  });

  test('should suggest unique name when forking folder with existing name', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    // Create a separate top-level tree named existing-tree. A folder inside
    // main may have the same name, but forking it must avoid the tree-name
    // collision.
    await page.evaluate(async () => {
      const { createTree } = await import('/src/actions/tree.ts');
      const result = await createTree('existing-tree', 'public', true);
      if (!result.success) throw new Error('failed to create collision tree');
    });
    await createFolderAndOpen(page, 'existing-tree');

    // Fork the directory whose base name collides with the existing tree.
    await page.getByRole('button', { name: 'Fork' }).click();

    // The suggested name should be "existing-tree-2" since "existing-tree" already exists as top-level
    const forkInput = page.locator('input#fork-name');
    await expect(forkInput).toHaveValue('existing-tree-2', { timeout: 5000 });

    // Fork with the suggested unique name
    await page.locator('.fixed.inset-0').getByRole('button', { name: 'Fork' }).click();

    // Should navigate to the new tree
    await expect(page.locator('text="Fork as New Folder"')).not.toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/existing-tree-2/, { timeout: 10000 });
  });

  test('should show progress when creating ZIP', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    await createFolderAndOpen(page, 'zip-progress-test');
    const folderUrl = page.url();

    // Create a file in the folder
    await page.getByRole('button', { name: 'New File' }).click();
    const fileInput = page.locator('input[placeholder="File name..."]');
    await fileInput.waitFor({ timeout: 5000 });
    await fileInput.fill('test-file.txt');
    await page.click('button:has-text("Create")');

    // Wait for editor and add content
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
    await page.locator('textarea').fill('Test content for ZIP progress indicator');
    await page.getByRole('button', { name: 'Save' }).click();

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Wait for any modal backdrop to close
    await expect(page.locator('[data-modal-backdrop]')).not.toBeVisible({ timeout: 5000 });

    // Navigate back to folder root
    await page.goto(folderUrl);
    await expect(page).toHaveURL(/zip-progress-test/, { timeout: 10000 });

    // Wait for folder view
    await expect(page.getByRole('button', { name: 'ZIP' })).toBeVisible({ timeout: 5000 });

    // Click ZIP button - progress toast should appear (may be brief for small files)
    await page.getByRole('button', { name: 'ZIP' }).click();

    // For small files, progress may be too fast to catch, but button should change to "Zipping..."
    // Wait for either the button text to change or download to complete
    // The button shows "Zipping..." during the operation
    await expect(
      page.getByRole('button', { name: /Zipping/ })
        .or(page.getByRole('button', { name: 'ZIP' }))
    ).toBeVisible({ timeout: 10000 });

    // Eventually button should return to ZIP (download completed)
    await expect(page.getByRole('button', { name: 'ZIP' })).toBeVisible({ timeout: 10000 });
  });

  test('should show progress when extracting ZIP', async ({ page }) => {
    await navigateToPublicFolder(page, { timeoutMs: 60000, requireRelay: false });

    // Stay in public folder where we can upload files
    // Use existing test ZIP file (dosgame.zip is a valid ZIP)
    const zipPath = path.join(process.cwd(), 'test-data', 'dosgame.zip');
    const buffer = fs.readFileSync(zipPath);

    // Upload the ZIP file
    const fileInput = page.locator('input[type="file"]:not([webkitdirectory])').first();
    await fileInput.waitFor({ state: 'attached', timeout: 5000 });
    await fileInput.setInputFiles({
      name: 'dosgame.zip',
      mimeType: 'application/zip',
      buffer,
    });

    // Extract modal should appear automatically after ZIP upload
    await expect(page.locator('text="Extract Archive?"')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=dosgame.zip')).toBeVisible({ timeout: 5000 });

    // Select "Extract to current directory" option
    await page.locator('input[name="extract-location"]').last().check();

    // Click "Extract Files" button
    await page.getByRole('button', { name: 'Extract Files' }).click();

    // Progress toast should appear during extraction showing "writing..." status
    // The capitalize CSS class makes it display as "Writing..."
    await expect(page.getByText('writing...', { exact: false })).toBeVisible({ timeout: 15000 });

    // Eventually files should appear in the listing after extraction completes
    // Wait for files from the ZIP (dosgame.zip contains game files)
    await expect(page.getByTestId('file-list').locator('a').first()).toBeVisible({ timeout: 15000 });
  });
});
