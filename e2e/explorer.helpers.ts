import { expect } from './fixtures';
import {
  configureBlossomServers,
  disableOthersPool,
  flushPendingPublishes,
  goToTreeList,
  navigateToPublicFolder,
  safeReload,
  setupPageErrorHandler,
  waitForAppReady,
} from './test-utils.js';

export { flushPendingPublishes, goToTreeList, safeReload, waitForAppReady };

export async function createAndEnterTree(page: any, name: string) {
  await goToTreeList(page);
  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.locator('input[placeholder="Folder name..."]').fill(name);
  // Creating a child folder leaves the current directory open.
  const deadline = Date.now() + 10000;
  const remaining = () => Math.max(1, deadline - Date.now());
  await page.getByRole('button', { name: 'Create', exact: true }).click({ timeout: remaining() });
  const folderLink = page.getByTestId('file-list').getByRole('link', { name, exact: true });
  await expect(folderLink).toBeVisible({ timeout: remaining() });
  const folderHref = await folderLink.getAttribute('href');
  if (!folderHref) throw new Error(`Missing folder link for ${name}`);
  const folderHash = new URL(folderHref, page.url()).hash;
  await Promise.all([
    page.waitForURL((url: URL) => url.hash === folderHash, { timeout: remaining() }),
    folderLink.click({ timeout: remaining() }),
  ]);
  await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });
}

export async function createAndOpenFile(page: any, name: string) {
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.locator('input[placeholder="File name..."]').fill(name);
  await Promise.all([
    page.waitForURL(new RegExp(encodeURIComponent(name)), { timeout: 10000 }),
    page.getByRole('button', { name: 'Create' }).click({ noWaitAfter: true }),
  ]);
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 });
}

export async function prepareExplorerPage(page: any) {
  setupPageErrorHandler(page);
  await page.goto('/');
  await disableOthersPool(page);
  await configureBlossomServers(page);

  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
    localStorage.clear();
    sessionStorage.clear();
  });

  await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
  await waitForAppReady(page);
  await disableOthersPool(page);
  await configureBlossomServers(page);
  await navigateToPublicFolder(page);
}
