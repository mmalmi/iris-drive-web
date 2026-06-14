import { test, expect } from './fixtures';
import {
  enableOthersPool,
  ensureTreeRootHash,
  flushPendingPublishes,
  getTestRelayUrl,
  getTreeRootInfo,
  initUser,
  prefetchByHash,
  prefetchTreePath,
  readFileTextViaWorker,
  safeGoto,
  seedTreeRoot,
  tryPrefetch,
  useLocalRelay,
  waitForAppReady,
  waitForFollowInWorker,
  waitForPeerConnection,
  withRelayNamespace,
} from './direct-tree-nav.helpers';

test.describe.serial('Direct Tree Navigation', () => {
  test('can access file from second context via WebRTC', { timeout: 180000 }, async ({ browser }) => {
    test.slow();
    test.setTimeout(240000);

    const relayNamespace = `direct-tree-nav-file-${test.info().workerIndex}-${Date.now()}`;
    const relayUrl = withRelayNamespace(getTestRelayUrl(), relayNamespace);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const user1 = await initUser(page1, relayUrl, { enableOthersPool: true });

    // Create a folder and file
    await page1.getByRole('button', { name: 'New Folder' }).click();
    const folderInput = page1.locator('input[placeholder="Folder name..."]');
    await folderInput.waitFor({ timeout: 5000 });
    await folderInput.fill('webrtc-nav-test');
    await page1.click('button:has-text("Create")');
    await expect(page1.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

    const folderLink = page1.locator('[data-testid="file-list"] a').filter({ hasText: 'webrtc-nav-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page1.waitForURL(/webrtc-nav-test/, { timeout: 10000 });

    // Create file via tree API
    const fileHashHex = await page1.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();
      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;
      const content = new TextEncoder().encode('Hello from WebRTC test!');
      const { cid, size } = await tree.putFile(content);
      rootCid = await tree.setEntry(rootCid, route.path, 'test.txt', cid, size, LinkType.Blob);
      autosaveIfOwn(rootCid);
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return toHex(cid.hash);
    });
    expect(fileHashHex).toBeTruthy();

    await expect(page1.locator('[data-testid="file-list"] a').filter({ hasText: 'test.txt' })).toBeVisible({ timeout: 15000 });
    const fileUrl = page1.url().replace(/\/$/, '') + '/test.txt';
    const fileHash = new URL(fileUrl).hash;
    console.log('[test] File URL:', fileUrl);

    // Flush publishes to relay
    await flushPendingPublishes(page1);
    const rootInfo = await getTreeRootInfo(page1, user1.npub, 'public');
    expect(rootInfo?.hashHex).toBeTruthy();
    if (!rootInfo?.hashHex) {
      throw new Error('Missing tree root after publish');
    }
    const rootHashAfterPublish = rootInfo.hashHex;

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    const user2 = await initUser(page2, relayUrl, { enableOthersPool: true });

    // Follow each other without navigating away
    await page1.waitForFunction(() => (window as any).__testHelpers?.followPubkey);
    await page2.waitForFunction(() => (window as any).__testHelpers?.followPubkey);
    await page1.evaluate((pk: string) => (window as any).__testHelpers?.followPubkey?.(pk), user2.pubkeyHex);
    await page2.evaluate((pk: string) => (window as any).__testHelpers?.followPubkey?.(pk), user1.pubkeyHex);
    await waitForFollowInWorker(page1, user2.pubkeyHex);
    await waitForFollowInWorker(page2, user1.pubkeyHex);
    await page1.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await waitForPeerConnection(page1, user2.pubkeyHex, 90000);
    await waitForPeerConnection(page2, user1.pubkeyHex, 90000);
    await page2.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await ensureTreeRootHash(page2, user1.npub, 'public', rootInfo, 60000);

    const isViewingFile = await page2.evaluate(async () => {
      const { isViewingFileStore } = await import('/src/stores/index.ts');
      let viewing = false;
      const unsub = isViewingFileStore.subscribe((v: boolean) => { viewing = v; });
      unsub();
      return viewing;
    });
    if (!isViewingFile) {
      const dirUrl = fileUrl.replace(/\/test\.txt$/, '');
      await safeGoto(page2, dirUrl, { retries: 4, delayMs: 1500 });
      await waitForAppReady(page2);
      const fileLink = page2.locator('[data-testid="file-list"] a').filter({ hasText: 'test.txt' }).first();
      if (await fileLink.isVisible().catch(() => false)) {
        await fileLink.click().catch(() => {});
        await page2.waitForURL(/test\.txt/, { timeout: 15000 }).catch(() => {});
      }
      await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    }

    await safeGoto(page2, fileUrl, { retries: 4, delayMs: 1500 });
    await expect(page2).toHaveURL(/webrtc-nav-test\/test\.txt/, { timeout: 15000 });
    await waitForAppReady(page2);
    await enableOthersPool(page2, 6);
    await useLocalRelay(page2, relayUrl);
    await waitForRelayConnected(page2, 30000);
    await page2.evaluate((hash) => {
      if (window.location.hash !== hash) {
        window.location.hash = hash;
      }
    }, fileHash);

    await waitForFollowInWorker(page2, user1.pubkeyHex);
    await page1.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await waitForPeerConnection(page1, user2.pubkeyHex, 90000);
    await waitForPeerConnection(page2, user1.pubkeyHex, 90000);
    await page2.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await ensureTreeRootHash(page2, user1.npub, 'public', rootInfo, 60000);

    const fileRouteState = await page2.evaluate(async () => {
      const { currentPath } = await import('/src/lib/router.svelte');
      const { routeStore, currentDirCidStore, isViewingFileStore, directoryEntriesStore, treeRootStore } = await import('/src/stores/index.ts');
      let pathValue = '';
      let routeValue: any = null;
      let rootCid: any = null;
      let dirCid: any = null;
      let isViewingFile = false;
      let entriesCount = 0;
      const unsubPath = currentPath.subscribe((v: string) => { pathValue = v; });
      const unsubRoute = routeStore.subscribe((v: any) => { routeValue = v; });
      const unsubRoot = treeRootStore.subscribe((v: any) => { rootCid = v; });
      const unsubDir = currentDirCidStore.subscribe((v: any) => { dirCid = v; });
      const unsubView = isViewingFileStore.subscribe((v: boolean) => { isViewingFile = v; });
      const unsubEntries = directoryEntriesStore.subscribe((v: any) => { entriesCount = v.entries?.length ?? 0; });
      unsubPath();
      unsubRoute();
      unsubRoot();
      unsubDir();
      unsubView();
      unsubEntries();
      return { hash: window.location.hash, pathValue, routeValue, rootCid, dirCid, isViewingFile, entriesCount };
    });
    console.log('[test] file route state:', JSON.stringify(fileRouteState));

    const contentLocator = page2.locator('pre').filter({ hasText: 'Hello from WebRTC test!' });
    const fileLink = page2.locator('[data-testid="file-list"] a').filter({ hasText: 'test.txt' }).first();
    const filePath = 'webrtc-nav-test/test.txt';
    await tryPrefetch('root', () => prefetchByHash(page2, rootHashAfterPublish, 120000));
    const pathPrefetchOk = await prefetchTreePath(page2, user1.npub, 'public', filePath, 120000);
    if (!pathPrefetchOk) {
      console.warn('[test] path prefetch failed: timed out waiting for entry');
    }
    await tryPrefetch('file', () => prefetchByHash(page2, fileHashHex!, 120000));
    if (await fileLink.isVisible().catch(() => false)) {
      await fileLink.click().catch(() => {});
      await page2.waitForURL(/test\.txt/, { timeout: 15000 }).catch(() => {});
    } else {
      await safeGoto(page2, fileUrl, { retries: 4, delayMs: 1500 });
      await waitForAppReady(page2);
    }

    const waitForContentReady = async (timeoutMs: number): Promise<boolean> => {
      try {
        await expect.poll(async () => {
          await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
          if (await contentLocator.isVisible().catch(() => false)) return true;
          const fileText = await readFileTextViaWorker(page2, user1.npub, 'public', filePath);
          if (fileText === '__fetched__' || fileText?.includes('Hello from WebRTC test!')) {
            if (await fileLink.isVisible().catch(() => false)) {
              await fileLink.click().catch(() => {});
              await page2.waitForURL(/test\.txt/, { timeout: 15000 }).catch(() => {});
            }
            return true;
          }
          return contentLocator.isVisible().catch(() => false);
        }, { timeout: timeoutMs, intervals: [1000, 2000, 5000] }).toBe(true);
        return true;
      } catch {
        return false;
      }
    };

    let contentReady = await waitForContentReady(120000);
    if (!contentReady) {
      console.warn('[direct-tree-nav] WebRTC content delayed; priming tree root and retrying once');
      await seedTreeRoot(page2, user1.npub, 'public', rootInfo);
      await safeGoto(page2, fileUrl, { retries: 3, delayMs: 1500 });
      await waitForAppReady(page2);
      await page2.evaluate((hash) => {
        if (window.location.hash !== hash) {
          window.location.hash = hash;
          window.dispatchEvent(new HashChangeEvent('hashchange'));
        }
        (window as any).__workerAdapter?.sendHello?.();
      }, fileHash);
      contentReady = await waitForContentReady(60000);
    }

    if (!contentReady) {
      console.warn('[direct-tree-nav] WebRTC content not available in time');
      await context2.close();
      await context1.close();
      throw new Error('WebRTC content not available in time');
    }

    await context2.close();
    await context1.close();
  });

  test('can access directory listing from second context via WebRTC', { timeout: 120000 }, async ({ browser }) => {
    test.slow();

    const relayNamespace = `direct-tree-nav-dir-${test.info().workerIndex}-${Date.now()}`;
    const relayUrl = withRelayNamespace(getTestRelayUrl(), relayNamespace);

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const user1 = await initUser(page1, relayUrl, { enableOthersPool: true });

    // Create folder
    await page1.getByRole('button', { name: 'New Folder' }).click();
    const folderInput = page1.locator('input[placeholder="Folder name..."]');
    await folderInput.waitFor({ timeout: 5000 });
    await folderInput.fill('webrtc-dir-test');
    await page1.click('button:has-text("Create")');
    await expect(page1.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });

    const folderLink = page1.locator('[data-testid="file-list"] a').filter({ hasText: 'webrtc-dir-test' }).first();
    await expect(folderLink).toBeVisible({ timeout: 15000 });
    await folderLink.click();
    await page1.waitForURL(/webrtc-dir-test/, { timeout: 10000 });

    // Create files
    await page1.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();
      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) return;

      const content1 = new TextEncoder().encode('File 1');
      const { cid: cid1, size: size1 } = await tree.putFile(content1);
      rootCid = await tree.setEntry(rootCid, route.path, 'file1.txt', cid1, size1, LinkType.Blob);

      const content2 = new TextEncoder().encode('File 2');
      const { cid: cid2, size: size2 } = await tree.putFile(content2);
      rootCid = await tree.setEntry(rootCid, route.path, 'file2.txt', cid2, size2, LinkType.Blob);

      autosaveIfOwn(rootCid);
    });

    await expect(page1.locator('[data-testid="file-list"] a').filter({ hasText: 'file1.txt' })).toBeVisible({ timeout: 15000 });
    const dirUrl = page1.url();
    console.log('[test] Dir URL:', dirUrl);

    await flushPendingPublishes(page1);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    const user2 = await initUser(page2, relayUrl, { enableOthersPool: true });

    await page1.waitForFunction(() => (window as any).__testHelpers?.followPubkey);
    await page2.waitForFunction(() => (window as any).__testHelpers?.followPubkey);
    await page1.evaluate((pk: string) => (window as any).__testHelpers?.followPubkey?.(pk), user2.pubkeyHex);
    await page2.evaluate((pk: string) => (window as any).__testHelpers?.followPubkey?.(pk), user1.pubkeyHex);
    await waitForFollowInWorker(page1, user2.pubkeyHex);
    await waitForFollowInWorker(page2, user1.pubkeyHex);
    await page1.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await waitForPeerConnection(page1, user2.pubkeyHex, 90000);
    await waitForPeerConnection(page2, user1.pubkeyHex, 90000);

    await safeGoto(page2, dirUrl, { retries: 4, delayMs: 1500 });
    await expect(page2).toHaveURL(/webrtc-dir-test/, { timeout: 15000 });
    await waitForAppReady(page2);
    await enableOthersPool(page2, 6);
    await useLocalRelay(page2, relayUrl);

    await waitForFollowInWorker(page2, user1.pubkeyHex);
    await page1.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
    await waitForPeerConnection(page1, user2.pubkeyHex, 90000);
    await waitForPeerConnection(page2, user1.pubkeyHex, 90000);

    const dirRouteState = await page2.evaluate(async () => {
      const { currentPath } = await import('/src/lib/router.svelte');
      const { routeStore, currentDirCidStore, isViewingFileStore, directoryEntriesStore, treeRootStore } = await import('/src/stores/index.ts');
      let pathValue = '';
      let routeValue: any = null;
      let rootCid: any = null;
      let dirCid: any = null;
      let isViewingFile = false;
      let entriesCount = 0;
      const unsubPath = currentPath.subscribe((v: string) => { pathValue = v; });
      const unsubRoute = routeStore.subscribe((v: any) => { routeValue = v; });
      const unsubRoot = treeRootStore.subscribe((v: any) => { rootCid = v; });
      const unsubDir = currentDirCidStore.subscribe((v: any) => { dirCid = v; });
      const unsubView = isViewingFileStore.subscribe((v: boolean) => { isViewingFile = v; });
      const unsubEntries = directoryEntriesStore.subscribe((v: any) => { entriesCount = v.entries?.length ?? 0; });
      unsubPath();
      unsubRoute();
      unsubRoot();
      unsubDir();
      unsubView();
      unsubEntries();
      return { hash: window.location.hash, pathValue, routeValue, rootCid, dirCid, isViewingFile, entriesCount };
    });
    console.log('[test] dir route state:', JSON.stringify(dirRouteState));

    await page2.waitForFunction(async () => {
      const { getTree } = await import('/src/store.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const tree = getTree();
      const rootCid = getCurrentRootCid();
      if (!rootCid) return false;
      const route = getRouteSync();
      const resolved = await tree.resolvePath(rootCid, route.path);
      if (!resolved) return false;
      const entries = await tree.listDirectory(resolved.cid);
      const names = entries.map((entry) => entry.name);
      return names.includes('file1.txt') && names.includes('file2.txt');
    }, null, { timeout: 90000 });

    await context2.close();
    await context1.close();
  });
});
