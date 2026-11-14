import { expect } from '../fixtures';
import { evaluateWithRetry, safeGoto, saveTextFile, setupPageErrorHandler, waitForAppReady } from './core';
import { waitForRelayConnected } from './network';

/**
 * Ensure a user is logged in (create a new account if needed).
 */
export async function ensureLoggedIn(page: any, timeoutMs: number = 15000) {
  const hasLoggedInPubkey = () => evaluateWithRetry(page, () => {
    const nostrStore = (window as any).__nostrStore;
    return (nostrStore?.getState?.().pubkey?.length ?? 0) === 64;
  }, undefined).catch(() => false);
  const alreadyLoggedIn = await hasLoggedInPubkey();

  if (!alreadyLoggedIn) {
    await evaluateWithRetry(page, () => {
      void import('/src/nostr.ts')
        .then(({ generateNewKey }) => generateNewKey())
        .catch((err) => console.error('[test-utils] generateNewKey failed', err));
    }, undefined);
  }

  await page.waitForFunction(() => {
    const nostrStore = (window as any).__nostrStore;
    return nostrStore?.getState()?.pubkey?.length === 64;
  }, undefined, { timeout: timeoutMs });
}

/**
 * Opens the signed-in test account's "public" tree. In test mode a new account
 * gets "public", "link" and "private" trees beside My Drive; the home link
 * opens My Drive, so the tree is opened by its address.
 */
export async function navigateToPublicFolder(
  page: any,
  options?: { timeoutMs?: number; requireRelay?: boolean }
) {
  const timeoutMs = options?.timeoutMs ?? 30000;
  await waitForAppReady(page, timeoutMs);
  await ensureLoggedIn(page, timeoutMs);
  if (options?.requireRelay ?? true) {
    await waitForRelayConnected(page, timeoutMs);
  } else {
    await waitForRelayConnected(page, Math.min(timeoutMs, 3000)).catch(() => {});
  }
  const npub = await evaluateWithRetry(page, () => (window as any).__nostrStore?.getState?.().npub ?? null, undefined);
  if (!npub) throw new Error('Failed to resolve logged-in npub for public folder navigation');

  // The default trees are made in the background; make "public" only if they never come.
  await page.evaluate(async (owner: string) => {
    const { getLocalRootCache } = await import('/src/treeRootCache.ts');
    const deadline = Date.now() + 10000;
    while (!getLocalRootCache(owner, 'public') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (getLocalRootCache(owner, 'public')) return;
    const { createTree } = await import('/src/actions/tree.ts');
    await createTree('public', 'public', true);
  }, npub);

  const appPath = new URL(page.url()).pathname || '/';
  const targetHash = `#/${npub}/public`;
  await page.evaluate((hash: string) => { window.location.hash = hash; }, targetHash);
  const navigated = await page.waitForFunction(
    (hash: string) => window.location.hash === hash,
    targetHash,
    { timeout: 5000 },
  ).then(() => true).catch(() => false);
  if (!navigated) {
    await safeGoto(page, `${appPath}${targetHash}`, { timeoutMs, retries: 3, delayMs: 500 });
    await waitForAppReady(page, timeoutMs);
  }
  await expectFolderEditable(page, Math.max(20000, timeoutMs));
}

/**
 * Navigate to the user's home directory.
 * Clicks the logo in the header and follows its active-account root link.
 */
export async function goToTreeList(page: any) {
  const logoLink = page.getByTestId('home-link');
  await expect(logoLink).toBeVisible({ timeout: 30000 });
  const homeHref = await logoLink.getAttribute('href');
  if (!homeHref?.startsWith('#/')) {
    throw new Error(`Invalid home link: ${homeHref ?? 'missing'}`);
  }
  await logoLink.click();
  await page.waitForFunction(
    (expectedHash) => window.location.hash === expectedHash,
    homeHref,
    { timeout: 15000 },
  );

  // The home directory uses the same file list container as other directories.
  await expect(page.locator('[data-testid="file-list"]').first()).toBeVisible({ timeout: 30000 });
}

export async function waitForCurrentDirectoryEntries(
  page: any,
  entryNames: string[],
  timeoutMs: number = 15000
) {
  const fileList = page.locator('[data-testid="file-list"]').first();
  await expect(fileList).toBeVisible({ timeout: timeoutMs });
  for (const entryName of entryNames) {
    await expect(fileList.locator('a').filter({ hasText: entryName }).first()).toBeVisible({ timeout: timeoutMs });
  }
}

export type NewMenuChoice =
  | 'Folder'
  | 'Document'
  | 'Spreadsheet'
  | 'Presentation'
  | 'Text file'
  | 'Upload files'
  | 'Upload folder';

/** The button that opens the New menu: in the sidebar, in a folder's header, or floating on a phone. */
export function newMenuButton(page: any) {
  return page.locator('[data-testid="new-menu"]:visible').first();
}

/** The open folder's file input, which takes files without opening the New menu. */
export function uploadFilesInput(page: any) {
  return page.getByTestId('upload-files-input');
}

/** Waits until the open folder can be added to: its header offers New. */
export async function expectFolderEditable(page: any, timeoutMs: number = 30000) {
  await expect(uploadFilesInput(page)).toBeAttached({ timeout: timeoutMs });
  await expect(newMenuButton(page)).toBeVisible({ timeout: timeoutMs });
}

/** Opens the New menu, unless it is open already, and returns it. */
export async function openNewMenu(page: any) {
  const menu = page.getByRole('menu', { name: 'New' });
  if (!await menu.isVisible().catch(() => false)) {
    await newMenuButton(page).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Makes something in the folder that is open, from the New menu. Creating
 * opens the dialog for its name; uploading opens the file chooser.
 */
export async function chooseNew(page: any, choice: NewMenuChoice, options?: { timeoutMs?: number }) {
  await expectFolderEditable(page, options?.timeoutMs ?? 30000);
  const menu = await openNewMenu(page);
  await menu.getByRole('menuitem', { name: choice, exact: true }).click();
}

/**
 * Create a new folder using the UI.
 * Chooses New > Folder, fills the name, and waits for modal to close.
 *
 * @param page - Playwright page
 * @param folderName - Name of the folder to create
 */
export async function createFolder(page: any, folderName: string) {
  await chooseNew(page, 'Folder');
  const input = page.locator('input[placeholder="Folder name..."]');
  await input.waitFor({ timeout: 5000 });
  await input.fill(folderName);
  await page.click('button:has-text("Create")');
  await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });
}

/** Makes a folder in the open folder from the New menu and opens it. */
export async function createAndEnterFolder(page: any, name: string) {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  const folderLink = page.getByTestId('file-list').getByRole('link', { name, exact: true });
  await expect(folderLink).toBeVisible({ timeout: 30000 });
  const folderHash = new URL((await folderLink.getAttribute('href'))!, page.url()).hash;
  await folderLink.click();
  await page.waitForURL((url: URL) => url.hash === folderHash, { timeout: 30000 });
  await expect(page.getByTestId('empty-folder')).toBeVisible({ timeout: 30000 });
}

/**
 * Makes a text file in the open folder from the New menu, writes and saves
 * what is given, and goes back to the folder, where the file is listed.
 */
export async function createTextFile(page: any, name: string, content = '') {
  await chooseNew(page, 'Text file');
  await page.getByPlaceholder('File name...').fill(name);
  await page.getByPlaceholder('File name...').press('Enter');
  const editor = page.locator('textarea');
  await expect(editor).toBeVisible({ timeout: 30000 });
  if (content) {
    await editor.fill(content);
    await saveTextFile(page);
  }
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(editor).toBeHidden({ timeout: 30000 });
  await page.getByTestId('viewer-back').click();
  await expectFolderEditable(page);
  await expect(page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) })).toBeVisible({ timeout: 30000 });
}

/**
 * Clear all browser storage (IndexedDB, localStorage, sessionStorage).
 * Use this to reset state between tests or create a fresh user.
 */
export async function clearAllStorage(page: any) {
  await evaluateWithRetry(page, async () => {
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map((db) => new Promise<void>((resolve) => {
      if (!db.name) {
        resolve();
        return;
      }
      const req = indexedDB.deleteDatabase(db.name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    })));
    localStorage.clear();
    sessionStorage.clear();
  }, undefined, 6);
}

/**
 * Setup a fresh user by clearing all storage and reloading.
 * Combines setupPageErrorHandler, goto, clearAllStorage, reload, and waitForAppReady.
 */
export async function setupFreshUser(page: any, options?: { timeoutMs?: number }) {
  setupPageErrorHandler(page);
  await safeGoto(page, '/', { retries: 4, delayMs: 1500 });
  await clearAllStorage(page);
  await safeGoto(page, '/', { retries: 4, delayMs: 1500 });
  await waitForAppReady(page, options?.timeoutMs ?? 30000);
}

/**
 * Add a file to the tree via the tree API.
 * This is faster than using the UI for file creation in tests.
 *
 * @param page - Playwright page
 * @param routePath - Path segments to the parent directory (empty for root)
 * @param filename - Name of the file to create
 * @param content - Text content of the file
 * @returns The new root CID, or null if failed
 */
export async function addFileViaTreeAPI(page: any, routePath: string[], filename: string, content: string): Promise<string | null> {
  return page.evaluate(async ({ routePath, filename, content }: { routePath: string[], filename: string, content: string }) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { toHex } = await import('/src/lib/nhash.ts');
    const { autosaveIfOwn } = await import('/src/nostr.ts');
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const tree = getTree();
    const rootCid = getCurrentRootCid();
    if (!rootCid) return null;
    const data = new TextEncoder().encode(content);
    const { cid: fileCid, size } = await tree.putFile(data);
    const newRootCid = await tree.setEntry(rootCid, routePath, filename, fileCid, size, LinkType.Blob);
    autosaveIfOwn(newRootCid);
    return toHex(newRootCid.hash);
  }, { routePath, filename, content });
}

/**
 * Opens the menu beside a folder's name that holds its less common actions:
 * Snapshot, Download ZIP, Fork, Push, Stream, Rename and Delete.
 */
export async function openFolderMenu(page: any): Promise<void> {
  const menu = page.getByTestId('folder-menu').filter({ visible: true });
  if (await menu.count()) return;
  await page.getByTestId('folder-menu-btn').filter({ visible: true }).first().click();
  await expect(menu).toBeVisible();
}
