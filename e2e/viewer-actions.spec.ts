import { test, expect, type Page } from './fixtures';
import {
  clearAllStorage,
  setupPageErrorHandler,
  navigateToPublicFolder,
  presetLocalRelayInDB,
} from './test-utils.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

async function waitForWritableTree(page: Page) {
  await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    return !!getCurrentRootCid();
  }, { timeout: 30000 });
}

async function createFile(page: Page, name: string, content = '') {
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
    await navigateToPublicFolder(page, { requireRelay: false });
  });

  test('shows file actions, icon, snapshot, and both share URL forms', async ({ page }) => {
    await waitForWritableTree(page);
    await createFile(page, 'actions.js', 'console.log("actions")');
    await page.locator('a:has-text("actions.js")').first().click();
    await expect(page.getByTestId('viewer-header').locator('.i-lucide-file-code')).toBeVisible();
    const backButton = page.getByTestId('viewer-back');
    await expect(backButton).toBeVisible();

    const downloadButton = page.getByTestId('viewer-download');
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toHaveText('Download');
    const permalinkButton = page.getByTestId('viewer-permalink');
    await expect(permalinkButton).toBeVisible();
    await expect(permalinkButton).toHaveText('Snapshot');
    await expect(permalinkButton).toHaveAttribute('href', /#\/nhash/);
    await expect(page.getByTestId('viewer-rename')).toBeVisible();
    await expect(page.getByTestId('viewer-edit')).toBeVisible();
    await expect(page.getByTestId('viewer-delete')).toBeVisible();
    await backButton.click();
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible();
    await page.locator('a:has-text("actions.js")').first().click();

    const shareButton = page.getByTestId('viewer-share');
    await expect(shareButton).toBeVisible();
    await shareButton.click();
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
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toBeHidden();
  });
});
