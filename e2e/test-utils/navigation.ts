import { expect } from '../fixtures';
import { evaluateWithRetry, safeGoto, setupPageErrorHandler, waitForAppReady } from './core';
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
  }, { timeout: timeoutMs });
}

/**
 * Wait for new user setup to complete and navigate to public folder.
 * New users get three default folders created (public, link, private).
 * This function waits for setup, then clicks into the public folder.
 */
export async function navigateToPublicFolder(
  page: any,
  options?: { timeoutMs?: number; requireRelay?: boolean }
) {
  const timeoutMs = options?.timeoutMs ?? 30000;
  const requireRelay = options?.requireRelay ?? true;
  const relayTimeoutMs = requireRelay ? timeoutMs : Math.min(timeoutMs, 3000);
  const waitForRelay = () => requireRelay
    ? waitForRelayConnected(page, relayTimeoutMs)
    : waitForRelayConnected(page, relayTimeoutMs).catch(() => {});
  const appPath = new URL(page.url()).pathname || '/';

  // First wait for the app to be ready - look for the Iris header
  await waitForAppReady(page, timeoutMs);
  await ensureLoggedIn(page, timeoutMs);
  await waitForRelay();

  // If we're already inside public (auto-redirect), just wait for actions and return
  const alreadyInPublic = await page.waitForFunction(() => {
    return /^#\/npub[^/]+\/public\/?(?:\?.*)?$/.test(window.location.hash);
  }, { timeout: 5000 }).then(() => true).catch(() => false);
  if (alreadyInPublic) {
    const actionsButton = page.getByRole('button', { name: /New Folder|File/i }).first();
    await expect(actionsButton).toBeVisible({ timeout: 10000 });
    return;
  }

  // Wait for the public folder link to appear in the tree list (indicates setup complete)
  // This can take a while for new users since default folders are created async
  // and published to Nostr fire-and-forget style
  const publicLink = page.getByRole('link', { name: 'public' }).first();
  const resolveLoggedInNpub = async () => {
    const storeNpub = await evaluateWithRetry(page, () => {
      const nostrStore = (window as any).__nostrStore;
      return nostrStore?.getState?.().npub ?? null;
    }, undefined).catch(() => null);
    if (storeNpub) return storeNpub;

    const publicHref = await publicLink.getAttribute('href').catch(() => null);
    const publicNpub = publicHref?.match(/#\/(npub1[^/]+)/)?.[1] ?? null;
    if (publicNpub) return publicNpub;

    return page.url().match(/npub1[a-z0-9]+/)?.[0] ?? null;
  };
  let npub = await resolveLoggedInNpub();

  if (!await publicLink.isVisible().catch(() => false)) {
    const logoLink = page.getByTestId('home-link');
    if (await logoLink.isVisible().catch(() => false)) {
      await logoLink.click();
    }
    await page.evaluate(async (treeNpub) => {
      const npub = treeNpub;
      if (!npub) return;
      const { getLocalRootCache } = await import('/src/treeRootCache.ts');
      const { createTree } = await import('/src/actions/tree.ts');
      const defaults: Array<{ name: string; visibility: 'public' | 'link-visible' | 'private' }> = [
        { name: 'public', visibility: 'public' },
        { name: 'link', visibility: 'link-visible' },
        { name: 'private', visibility: 'private' },
      ];
      for (const { name, visibility } of defaults) {
        if (!getLocalRootCache(npub, name)) {
          await createTree(name, visibility, true);
        }
      }
    }, npub).catch(() => {});
  }

  for (let attempt = 0; attempt < 2 && !await publicLink.isVisible().catch(() => false); attempt++) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForAppReady(page, timeoutMs);
    await waitForRelay();
    npub = npub ?? await resolveLoggedInNpub();
  }

  const publicHash = await publicLink.getAttribute('href').catch(() => null);
  const npubFromLink = publicHash?.match(/#\/(npub1[^/]+)/)?.[1] ?? null;
  let resolvedNpub = npub ?? npubFromLink;

  for (let attempt = 0; attempt < 5 && !resolvedNpub; attempt++) {
    await page.waitForTimeout(500);
    resolvedNpub = await resolveLoggedInNpub();
  }

  if (!resolvedNpub) {
    throw new Error('Failed to resolve logged-in npub for public folder navigation');
  }

  const targetHash = publicHash?.startsWith('#/') ? publicHash : `#/${resolvedNpub}/public`;
  await page.evaluate((hash) => {
    const nextHash = hash.startsWith('#') ? hash : `#${hash}`;
    if (window.location.hash === nextHash) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    window.location.hash = nextHash;
  }, targetHash).catch(() => {});
  const navigatedByHash = await page.waitForFunction(
    (hash) => window.location.hash === hash,
    targetHash,
    { timeout: 5000 }
  ).then(() => true).catch(() => false);
  if (!navigatedByHash) {
    await safeGoto(page, `${appPath}${targetHash}`, { timeoutMs, retries: 3, delayMs: 500 });
  }
  await waitForAppReady(page, timeoutMs);
  await waitForRelay();

  // Wait for navigation to complete and folder actions to be visible
  await page.waitForFunction(
    () => /^#\/npub[^/]+\/public\/?(?:\?.*)?$/.test(window.location.hash),
    undefined,
    { timeout: timeoutMs }
  );
  await expect(page.getByRole('button', { name: /New Folder|File/i }).first()).toBeVisible({ timeout: Math.max(20000, timeoutMs) });
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

/**
 * Create a new folder using the UI.
 * Clicks "New Folder" button, fills the name, and waits for modal to close.
 *
 * @param page - Playwright page
 * @param folderName - Name of the folder to create
 */
export async function createFolder(page: any, folderName: string) {
  await page.getByRole('button', { name: 'New Folder' }).click();
  const input = page.locator('input[placeholder="Folder name..."]');
  await input.waitFor({ timeout: 5000 });
  await input.fill(folderName);
  await page.click('button:has-text("Create")');
  await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });
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
 * Navigate into a folder by clicking its link in the file list.
 * Waits for the folder to appear and for navigation to complete.
 *
 * @param page - Playwright page
 * @param folderName - Name of the folder to navigate into
 */
export async function navigateIntoFolder(page: any, folderName: string) {
  const folderLink = page.locator('[data-testid="file-list"] a').filter({ hasText: folderName }).first();
  await expect(folderLink).toBeVisible({ timeout: 15000 });
  await folderLink.click();
  await page.waitForURL(new RegExp(folderName), { timeout: 10000 });
}

/**
 * Get the current directory's nhash permalink.
 * This uses the app's bundled hashtree module to avoid msgpack resolution issues.
 */
export async function getCurrentDirNhash(page: any): Promise<string | null> {
  return page.evaluate(async () => {
    const { currentDirCidStore } = await import('/src/stores/index.ts');
    const { nhashEncode } = await import('/src/lib/nhash.ts');

    let dirCid: { hash: Uint8Array; key?: Uint8Array } | null = null;
    const unsub = currentDirCidStore.subscribe((v: { hash: Uint8Array; key?: Uint8Array } | null) => { dirCid = v; });
    unsub();

    if (!dirCid) return null;
    return nhashEncode(dirCid);
  });
}
