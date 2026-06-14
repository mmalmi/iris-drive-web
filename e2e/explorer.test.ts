import { test, expect } from './fixtures';
import {
  createAndEnterTree,
  createAndOpenFile,
  flushPendingPublishes,
  goToTreeList,
  prepareExplorerPage,
  safeReload,
  waitForAppReady,
} from './explorer.helpers';

test.describe('Hashtree Explorer', () => {
  test.setTimeout(180000);
  test.beforeEach(async ({ page }) => {
    await prepareExplorerPage(page);
  });

  test('should display header and initial state', async ({ page }) => {
    await expect(page.locator('header').getByText('Drive').first()).toBeVisible({ timeout: 5000 });
    // New users are redirected to their public folder - shows "Empty directory" or folder actions
    await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 5000 });
  });

  // Uses File button instead of setInputFiles for reliable testing
  test('should create a local tree and create files', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree via modal - this navigates into empty tree
    await createAndEnterTree(page, 'test-tree');

    // Create a file using File button
    await createAndOpenFile(page, 'hello.txt');

    // File opens in edit mode - add content
    await page.locator('textarea').fill('Hello, World!');
    await page.getByRole('button', { name: 'Save' }).click();

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Navigate back to directory
    await page.locator('a:has-text("test-tree")').first().click();

    // File should appear in file browser
    await expect(fileList.locator('a').filter({ hasText: 'hello.txt' }).first()).toBeVisible({ timeout: 10000 });

    // Click to view content
    await fileList.locator('a:has-text("hello.txt")').click();
    await expect(page.locator('pre')).toContainText('Hello, World!', { timeout: 10000 });
  });

  test('should create file using File button', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree via modal
    await createAndEnterTree(page, 'file-btn-test');

    // Create file using File button - this auto-opens in edit mode
    await createAndOpenFile(page, 'test-file.txt');

    // File opens in edit mode - exit edit mode first
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Navigate back to the tree directory by clicking on the tree name in sidebar
    await page.locator('a:has-text("file-btn-test")').first().click();

    // File should appear in file browser (use a:has-text since entries are links)
    await expect(fileList.locator('a').filter({ hasText: 'test-file.txt' }).first()).toBeVisible({ timeout: 10000 });
  });

  test('should create and edit a file', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'edit-test');

    // Create new file using File button - this auto-navigates to edit mode
    await createAndOpenFile(page, 'editable.txt');

    // Type content and save
    await page.locator('textarea').fill('Hello, Hashtree!');
    await page.getByRole('button', { name: 'Save' }).click();

    // Click Done to exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Click on file in list to ensure it's selected
    await page.getByRole('link', { name: 'editable.txt' }).click();

    // Content should be visible in preview
    await expect(page.locator('pre')).toContainText('Hello, Hashtree!', { timeout: 10000 });
  });

  test('should persist file edits after navigation', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree via modal
    await createAndEnterTree(page, 'persist-test');

    // Create a file with initial content using File button
    await createAndOpenFile(page, 'persist.txt');

    // Type initial content and save
    await page.locator('textarea').fill('Initial content');
    await page.getByRole('button', { name: 'Save' }).click();

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Verify initial content
    await fileList.locator('a:has-text("persist.txt")').click();
    await expect(page.locator('pre')).toContainText('Initial content', { timeout: 10000 });

    // Now edit to new content
    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });

    // Clear and retype to ensure the change is detected
    await page.locator('textarea').clear();
    await page.locator('textarea').fill('Updated content');

    await page.getByRole('button', { name: 'Save' }).click();

    // Wait for save to complete by checking that Save button becomes disabled
    // (disabled when content matches savedContent, meaning save completed)
    await expect(page.getByRole('button', { name: /Save/ })).toBeDisabled({ timeout: 5000 });

    // Exit edit mode
    await page.getByRole('button', { name: 'Done' }).click();

    // Poll for the updated content to appear in preview
    // The file viewer should reload content after the store updates
    await fileList.locator('a:has-text("persist.txt")').click();
    await expect(page.locator('pre')).toContainText('Updated content', { timeout: 15000 });

    // Navigate to homepage
    await page.locator('header a[href="#/"]').click();

    // Navigate back to the tree
    await goToTreeList(page);

    await page.locator(`a:has-text("persist-test")`).first().click();

    // File should still be in the list (use a:has-text since entries are links)
    await expect(fileList.locator('a').filter({ hasText: 'persist.txt' }).first()).toBeVisible({ timeout: 10000 });

    // Click the file
    await fileList.locator('a:has-text("persist.txt")').click();

    // Content should still be the updated value (persisted correctly)
    await expect(page.locator('pre')).toContainText('Updated content', { timeout: 10000 });
  });

  test('should rename a file', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree via modal
    await createAndEnterTree(page, 'rename-test');

    // Create file using File button
    await createAndOpenFile(page, 'old-name.txt');

    // File opens in edit mode - add content
    await page.locator('textarea').fill('rename me');
    await page.getByRole('button', { name: 'Save' }).click();

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Done' }).click();

    // Wait for Rename button in preview toolbar to be visible
    await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible({ timeout: 5000 });

    // Click rename button
    await page.getByRole('button', { name: 'Rename' }).click();

    // Fill new name and submit by pressing Enter
    const input = page.locator('input[placeholder="New name..."]');
    await input.waitFor({ timeout: 5000 });
    await input.fill('new-name.txt');
    await input.press('Enter');

    // Wait for modal to close
    await expect(input).not.toBeVisible({ timeout: 5000 });

    // Navigate back to directory to see file list
    await page.locator('a:has-text("rename-test")').first().click();

    // Wait for new name to appear first (rename succeeded)
    await expect(fileList.locator('a').filter({ hasText: 'new-name.txt' }).first()).toBeVisible({ timeout: 10000 });
    // Then verify old name is gone
    await expect(fileList.locator('a').filter({ hasText: 'old-name.txt' })).not.toBeVisible({ timeout: 5000 });
  });

  test('should delete a file', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'delete-file-test');

    // Create two files so we can verify specific file is deleted
    await createAndOpenFile(page, 'keep-me.txt');
    await page.locator('textarea').fill('keep this');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Go back to directory - wait for back button to be visible first
    const backBtn = page.getByTestId('viewer-back');
    await expect(backBtn).toBeVisible({ timeout: 5000 });
    await backBtn.click();

    // Create file to delete
    await createAndOpenFile(page, 'to-delete.txt');
    await page.locator('textarea').fill('delete me');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Go back to directory to verify both files are visible
    await page.getByTestId('viewer-back').click();
    const fileList = page.getByTestId('file-list');
    await expect(fileList.locator('a').filter({ hasText: 'to-delete.txt' })).toBeVisible({ timeout: 5000 });
    await expect(fileList.locator('a').filter({ hasText: 'keep-me.txt' })).toBeVisible({ timeout: 5000 });

    // Click on file to delete to open it in viewer
    await fileList.locator('a').filter({ hasText: 'to-delete.txt' }).click();

    // Wait for Delete button to be visible in preview toolbar (confirms we're in view mode)
    const deleteBtn = page.getByTestId('viewer-delete');
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });

    // Click Delete button - set up dialog handler first
    page.once('dialog', dialog => dialog.accept());
    await deleteBtn.click();

    // Should navigate back to directory
    await expect(fileList).toBeVisible({ timeout: 5000 });

    // Verify deleted file is NOT listed
    await expect(fileList.locator('a').filter({ hasText: 'to-delete.txt' })).not.toBeVisible({ timeout: 5000 });

    // Verify other file IS still listed
    await expect(fileList.locator('a').filter({ hasText: 'keep-me.txt' })).toBeVisible({ timeout: 5000 });

    // Wait for Nostr publish (throttled 1s + network)
    await page.waitForTimeout(2000);

    // Reload and verify deletion persisted
    const treeUrl = page.url();
    await page.goto(treeUrl, { waitUntil: 'domcontentloaded' });
    await waitForAppReady(page);
    if (!page.url().includes('delete-file-test')) {
      await page.goto(treeUrl);
      await waitForAppReady(page);
    }
    await expect(fileList.locator('a').filter({ hasText: 'to-delete.txt' })).not.toBeVisible({ timeout: 15000 });
    await expect(fileList.locator('a').filter({ hasText: 'keep-me.txt' })).toBeVisible({ timeout: 10000 });
  });

  test('should delete a folder', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'delete-folder-test');

    // Create a folder
    await page.getByRole('button', { name: /Folder/ }).first().click();
    await page.locator('input[placeholder="Folder name..."]').fill('to-delete-folder');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(500);

    // Should see the folder in the list
    const fileList = page.getByTestId('file-list');
    await expect(fileList.locator('a').filter({ hasText: 'to-delete-folder' })).toBeVisible({ timeout: 5000 });

    // Click the folder to enter it
    await fileList.locator('a').filter({ hasText: 'to-delete-folder' }).click();
    await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 5000 });

    // Find and click delete button for the folder (in folder actions)
    // FolderActions renders in both FileBrowser and DirectoryActions (Viewer) - use visible one
    const deleteBtn = page.getByRole('button', { name: 'Delete' });
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });

    // Click Delete button - set up dialog handler first
    page.once('dialog', dialog => dialog.accept());
    await deleteBtn.click();

    // Should navigate back to parent directory
    await expect(fileList).toBeVisible({ timeout: 5000 });

    // Verify deleted folder is NOT listed
    await expect(fileList.locator('a').filter({ hasText: 'to-delete-folder' })).not.toBeVisible({ timeout: 5000 });

    // Wait for Nostr publish (throttled 1s + network)
    await page.waitForTimeout(2000);

    // Reload and verify deletion persisted
    const treeUrl = page.url();
    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page);
    if (!page.url().includes('delete-folder-test')) {
      await page.goto(treeUrl);
      await waitForAppReady(page);
    }
    await expect(fileList.locator('a').filter({ hasText: 'to-delete-folder' })).not.toBeVisible({ timeout: 15000 });
  });

  test('should handle tree names with slashes', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree with slash in name
    await createAndEnterTree(page, 'videos/test-folder');

    // Create a file
    await createAndOpenFile(page, 'test.txt');
    await page.locator('textarea').fill('content in slashed tree');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // Go back to directory
    const viewerBack = page.getByTestId('viewer-back');
    if (await viewerBack.isVisible().catch(() => false)) {
      await viewerBack.click();
    }
    await expect(fileList.locator('a').filter({ hasText: 'test.txt' })).toBeVisible({ timeout: 5000 });

    // Wait for publish
    await flushPendingPublishes(page);

    // Reload and verify file persisted
    const encodedTreeName = encodeURIComponent('videos/test-folder');
    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await waitForAppReady(page);
    const npub = await page.evaluate(() => (window as any).__nostrStore?.getState?.().npub ?? null);
    if (npub && !page.url().includes(encodedTreeName)) {
      await page.goto(`http://localhost:5173/#/${npub}/${encodedTreeName}`);
      await waitForAppReady(page);
    }
    await page.evaluate(async () => {
      const { waitForTreeRoot } = await import('/src/stores');
      const { getRouteSync } = await import('/src/stores/route');
      const route = getRouteSync();
      if (route.npub && route.treeName) {
        await waitForTreeRoot(route.npub, route.treeName, 30000);
      }
    });
    await expect(fileList.locator('a').filter({ hasText: 'test.txt' })).toBeVisible({ timeout: 15000 });

    // Verify content
    await fileList.locator('a').filter({ hasText: 'test.txt' }).click();
    await expect(page.locator('pre')).toContainText('content in slashed tree', { timeout: 5000 });
  });


  test('should open stream panel', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'stream-test');

    // Click Stream link (now a Link instead of button)
    const streamLink = page.getByRole('link', { name: /Stream/ }).first();
    await expect(streamLink).toBeVisible({ timeout: 5000 });
    await streamLink.click();
    await page.waitForTimeout(300);

    // Should navigate to stream route and show the livestream panel
    await expect(page.getByText('Livestream', { exact: true })).toBeVisible({ timeout: 5000 });

    // Should have Start Camera button
    await expect(page.getByRole('button', { name: 'Start Camera' })).toBeVisible({ timeout: 5000 });

    // Close panel by navigating back to the folder using browser
    await page.goBack();
    await page.waitForTimeout(500);

    // Should be back in the folder - Stream link should be visible again in the toolbar
    await expect(page.getByRole('link', { name: /Stream/ }).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show empty file content for new files', async ({ page }) => {
    const fileList = page.getByTestId('file-list');

    // Create tree via modal
    await createAndEnterTree(page, 'empty-file-test');

    // Create a file using File button
    await createAndOpenFile(page, 'empty.txt');

    // File opens in edit mode - exit without adding content (empty file)
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(300);

    // Navigate back to directory
    await page.locator('a:has-text("empty-file-test")').first().click();
    await page.waitForTimeout(500);

    // File should appear in file browser
    await expect(fileList.locator('a').filter({ hasText: 'empty.txt' }).first()).toBeVisible({ timeout: 10000 });

    // Click to view - empty files should show empty pre tag (not download pane)
    await fileList.locator('a:has-text("empty.txt")').click();
    await page.waitForTimeout(500);

    // Should show viewer header with filename
    await expect(page.getByTestId('viewer-header')).toBeVisible({ timeout: 5000 });
    // Should NOT show download pane for empty text files
    await expect(page.locator('span.i-lucide-download')).not.toBeVisible();
    // Pre element exists in DOM (may be hidden when empty, but that's ok)
    await expect(page.locator('pre')).toHaveCount(1);
  });

  test('should cancel editing without saving', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'cancel-test');

    // Create file using File button
    await createAndOpenFile(page, 'cancel-test.txt');

    // File opens in edit mode - add content
    await page.locator('textarea').fill('original');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForTimeout(500);

    // Exit edit mode
    await page.getByRole('button', { name: 'Done' }).click();

    // Wait for viewer header (file preview mode)
    await expect(page.getByTestId('viewer-header')).toBeVisible({ timeout: 5000 });

    // Wait for pre element with content
    await expect(page.locator('pre')).toContainText('original', { timeout: 5000 });

    // Re-enter edit mode using test id
    const editBtn = page.getByTestId('viewer-edit');
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    await editBtn.click();

    // Wait for textarea with current content
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await expect(textarea).toHaveValue('original', { timeout: 5000 });

    // Type something but don't save
    await textarea.fill('This will be cancelled');

    // Click Done without saving
    await page.getByRole('button', { name: 'Done' }).click();

    // Unsaved changes modal should appear - click "Don't Save" to discard changes
    await expect(page.getByRole('heading', { name: 'Unsaved Changes' })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: "Don't Save" }).click();

    // Should exit edit mode - verify viewer header is back
    await expect(page.getByTestId('viewer-header')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('textarea')).not.toBeVisible();
    await expect(editBtn).toBeVisible();
  });

  test('should close modal by clicking outside', async ({ page }) => {
    // Create tree via modal
    await createAndEnterTree(page, 'modal-test');

    await page.getByRole('button', { name: /File/ }).first().click();
    await expect(page.locator('input[placeholder="File name..."]')).toBeVisible();

    // Click outside the modal
    await page.locator('div.fixed.inset-0.bg-black\\/70').click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(200);

    await expect(page.locator('input[placeholder="File name..."]')).not.toBeVisible();
  });
});
