import { test, expect } from './fixtures';
import {
  clearAllStorage,
  setupPageErrorHandler,
  navigateToPublicFolder,
  presetLocalRelayInDB,
} from './test-utils.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

// Helper to ensure the current writable folder is ready.
async function createAndEnterTree(page: any, _name: string) {
  await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    return !!getCurrentRootCid();
  }, { timeout: 30000 });
}

// Helper to create a file and navigate back
async function createFile(page: any, name: string, content: string = '', _treeName: string = '') {
  const created = await page.evaluate(async ({ name, content }) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { autosaveIfOwn } = await import('/src/nostr.ts');
    const { getCurrentRootCid, getCurrentPathFromUrl } = await import('/src/actions/route.ts');
    const { initVirtualTree } = await import('/src/actions/tree.ts');
    const { markFilesChanged } = await import('/src/stores/recentlyChanged.ts');

    const tree = getTree();
    const data = new TextEncoder().encode(content);
    const { cid: fileCid, size } = await tree.putFile(data);
    const rootCid = getCurrentRootCid();
    const routePath = getCurrentPathFromUrl();
    const newRootCid = rootCid
      ? await tree.setEntry(rootCid, routePath, name, fileCid, size, LinkType.Blob)
      : await initVirtualTree([{ name, cid: fileCid, size, type: LinkType.Blob }]);

    if (!newRootCid) return false;
    if (rootCid) autosaveIfOwn(newRootCid);
    markFilesChanged(new Set([name]));
    return true;
  }, { name, content });
  expect(created).toBe(true);
  const fileLink = page.locator(`a:has-text("${name}")`).first();
  await expect(fileLink).toBeVisible({ timeout: 15000 });
}

test.describe('Viewer Actions', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await clearAllStorage(page);

    await presetLocalRelayInDB(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    // Page ready - navigateToPublicFolder handles waiting
    await navigateToPublicFolder(page, { requireRelay: false });
  });

  test('should show back button that navigates to directory', async ({ page }) => {
    await createAndEnterTree(page, 'back-btn-test');
    await createFile(page, 'test.txt', 'Test content', 'back-btn-test');

    // Click on file to view it
    await page.locator('a:has-text("test.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify we're viewing the file
    await expect(page.locator('pre')).toContainText('Test content', { timeout: 5000 });

    // Verify back button is visible
    const backButton = page.getByTestId('viewer-back');
    await expect(backButton).toBeVisible();

    // Click back button
    await backButton.click();
    await page.waitForTimeout(500);

    // Should be back in the directory (no file content visible, directory actions visible)
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 5000 });
  });

  test('should show download button for files', async ({ page }) => {
    await createAndEnterTree(page, 'download-test');
    await createFile(page, 'download.txt', 'Download me', 'download-test');

    await page.locator('a:has-text("download.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify download button exists
    const downloadButton = page.getByTestId('viewer-download');
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toHaveText('Download');
  });

  test('should show permalink button for files', async ({ page }) => {
    await createAndEnterTree(page, 'permalink-test');
    await createFile(page, 'perma.txt', 'Permanent content', 'permalink-test');

    await page.locator('a:has-text("perma.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify permalink button exists and is a link
    const permalinkButton = page.getByTestId('viewer-permalink');
    await expect(permalinkButton).toBeVisible();
    await expect(permalinkButton).toHaveText('Snapshot');

    // Permalink should be a link (anchor tag)
    const href = await permalinkButton.getAttribute('href');
    expect(href).toBeTruthy();
    // Should contain nhash format
    expect(href).toMatch(/#\/nhash/);
  });

  test('should show share button that opens share modal', async ({ page }) => {
    await createAndEnterTree(page, 'share-test');
    await createFile(page, 'share.txt', 'Share this', 'share-test');

    await page.locator('a:has-text("share.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify share button exists
    const shareButton = page.getByTestId('viewer-share');
    await expect(shareButton).toBeVisible();

    // Click share button
    await shareButton.click();

    // Share modal should open - look for modal or QR code
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('share-url-option-web')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('share-url-option-htree')).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('share-copy-url').click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('https://drive.iris.to/#/');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).not.toContain('htree.localhost');

    await page.getByTestId('share-url-option-htree').click();
    await expect(page.getByTestId('share-url-option-htree')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('share-copy-url').click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/drive#/');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).not.toContain('htree.localhost');
  });

  test('should show rename button for own files', async ({ page }) => {
    await createAndEnterTree(page, 'rename-test');
    await createFile(page, 'rename.txt', 'Rename me', 'rename-test');

    await page.locator('a:has-text("rename.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify rename button exists
    const renameButton = page.getByTestId('viewer-rename');
    await expect(renameButton).toBeVisible();
    await expect(renameButton).toHaveText('Rename');
  });

  test('should show edit button for text files', async ({ page }) => {
    await createAndEnterTree(page, 'edit-test');
    await createFile(page, 'editable.txt', 'Edit me', 'edit-test');

    await page.locator('a:has-text("editable.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify edit button exists for text file
    const editButton = page.getByTestId('viewer-edit');
    await expect(editButton).toBeVisible();
    await expect(editButton).toHaveText('Edit');
  });

  test('should show delete button for own files', async ({ page }) => {
    await createAndEnterTree(page, 'delete-test');
    await createFile(page, 'deletable.txt', 'Delete me', 'delete-test');

    await page.locator('a:has-text("deletable.txt")').first().click();
    await page.waitForTimeout(500);

    // Verify delete button exists
    const deleteButton = page.getByTestId('viewer-delete');
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toHaveText('Delete');
  });

  test('should show correct file icon for different file types', async ({ page }) => {
    await createAndEnterTree(page, 'icon-test');

    // Create different file types
    await createFile(page, 'code.js', 'console.log("test")', 'icon-test');

    await page.locator('a:has-text("code.js")').first().click();
    await page.waitForTimeout(500);

    // Viewer header should be visible with file icon
    const header = page.getByTestId('viewer-header');
    await expect(header).toBeVisible();

    // Should contain the file-code icon for .js files
    await expect(header.locator('.i-lucide-file-code')).toBeVisible();
  });

  test('viewer header should contain all action buttons', async ({ page }) => {
    await createAndEnterTree(page, 'all-actions-test');
    await createFile(page, 'actions.txt', 'All actions', 'all-actions-test');

    await page.locator('a:has-text("actions.txt")').first().click();
    await page.waitForTimeout(500);

    // All buttons should be visible for a text file owned by user
    await expect(page.getByTestId('viewer-back')).toBeVisible();
    await expect(page.getByTestId('viewer-download')).toBeVisible();
    await expect(page.getByTestId('viewer-permalink')).toBeVisible();
    await expect(page.getByTestId('viewer-share')).toBeVisible();
    await expect(page.getByTestId('viewer-rename')).toBeVisible();
    await expect(page.getByTestId('viewer-edit')).toBeVisible();
    await expect(page.getByTestId('viewer-delete')).toBeVisible();
  });
});
