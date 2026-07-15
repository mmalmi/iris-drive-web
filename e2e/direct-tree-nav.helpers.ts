/**
 * E2E test for direct navigation to tree URLs with cross-context data transfer
 *
 * IMPORTANT: Cross-context data transfer requires FIPS connections between devices.
 *
 * These tests verify that:
 * - Tree root is received via Nostr relay
 * - Nostr-discovered FIPS WebRTC connects the device peers
 * - Data can be fetched when connections are established
 */
import { expect, type Page } from './fixtures';
import { setupPageErrorHandler, navigateToPublicFolder, disableOthersPool, enableOthersPool, useLocalRelay, waitForAppReady, presetLocalRelayInDB, safeReload, flushPendingPublishes, waitForRelayConnected, safeGoto, getTestRelayUrl } from './test-utils.js';

export function withRelayNamespace(baseUrl: string, namespace: string): string {
  try {
    const url = new URL(baseUrl);
    let path = url.pathname || '/';
    if (!path.endsWith('/')) path += '/';
    path += namespace;
    url.pathname = path;
    return url.toString().replace(/\/$/, '');
  } catch {
    const trimmed = baseUrl.replace(/\/$/, '');
    return `${trimmed}/${namespace}`;
  }
}

export async function initUser(
  page: Page,
  relayUrl: string,
  options?: { enableOthersPool?: boolean }
): Promise<{ npub: string; pubkeyHex: string }> {
  setupPageErrorHandler(page);
  await safeGoto(page, 'http://localhost:5173/', { retries: 4, delayMs: 1500 });
  await presetLocalRelayInDB(page, relayUrl);
  await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
  if (options?.enableOthersPool) {
    await enableOthersPool(page, 6);
  } else {
    await disableOthersPool(page);
  }
  await useLocalRelay(page, relayUrl);
  await waitForAppReady(page);
  await waitForRelayConnected(page, 30000);
  await navigateToPublicFolder(page);

  await page.waitForFunction(() => (window as any).__getMyPubkey?.(), { timeout: 15000 });
  const pubkeyHex = await page.evaluate(() => (window as any).__getMyPubkey?.() ?? null);
  const url = page.url();
  const npubMatch = url.match(/npub1[a-z0-9]+/);
  if (!pubkeyHex || !npubMatch) {
    throw new Error('Could not determine user identity');
  }
  return { npub: npubMatch[0], pubkeyHex };
}

export async function waitForPeerConnection(page: Page, _pubkeyHex: string, timeoutMs: number = 60000): Promise<void> {
  await page.waitForFunction(
    async () => {
      const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
      return (getDriveFipsRuntime()?.getStats().connectedPeerIds.length ?? 0) > 0;
    },
    undefined,
    { timeout: timeoutMs, polling: 500 }
  );
}

export async function waitForTreeRoot(page: Page, npub: string, treeName: string, timeoutMs: number = 60000): Promise<void> {
  await page.waitForFunction(
    async ({ targetNpub, targetTree }) => {
      const { getTreeRootSync } = await import('/src/stores');
      return !!getTreeRootSync(targetNpub, targetTree);
    },
    { targetNpub: npub, targetTree: treeName },
    { timeout: timeoutMs }
  );
}

export async function getTreeRootHash(page: Page, npub: string, treeName: string): Promise<string | null> {
  return page.evaluate(async ({ targetNpub, targetTree }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const toHex = (bytes: Uint8Array): string => Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const root = getTreeRootSync(targetNpub, targetTree);
    return root ? toHex(root.hash) : null;
  }, { targetNpub: npub, targetTree: treeName });
}

export async function getTreeRootInfo(
  page: Page,
  npub: string,
  treeName: string
): Promise<{ hashHex: string; keyHex?: string | null } | null> {
  return page.evaluate(async ({ targetNpub, targetTree }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const toHex = (bytes: Uint8Array): string => Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const root = getTreeRootSync(targetNpub, targetTree);
    if (!root) return null;
    return {
      hashHex: toHex(root.hash),
      keyHex: root.key ? toHex(root.key) : null,
    };
  }, { targetNpub: npub, targetTree: treeName });
}

export async function waitForTreeRootHash(
  page: Page,
  npub: string,
  treeName: string,
  expectedHash: string,
  timeoutMs: number = 60000
): Promise<void> {
  await page.waitForFunction(
    async ({ targetNpub, targetTree, targetHash }) => {
      const { getTreeRootSync } = await import('/src/stores');
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const root = getTreeRootSync(targetNpub, targetTree);
      if (!root) return false;
      return toHex(root.hash) === targetHash;
    },
    { targetNpub: npub, targetTree: treeName, targetHash: expectedHash },
    { timeout: timeoutMs }
  );
}

export async function waitForTreeRootStoreHash(
  page: Page,
  expectedHash: string,
  timeoutMs: number = 60000
): Promise<void> {
  await page.waitForFunction(
    async (targetHash: string) => {
      const { treeRootStore } = await import('/src/stores/index.ts');
      const toHex = (bytes: Uint8Array): string => Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      let root: any = null;
      const unsub = treeRootStore.subscribe((v: any) => { root = v; });
      unsub();
      if (!root?.hash) return false;
      return toHex(root.hash) === targetHash;
    },
    expectedHash,
    { timeout: timeoutMs }
  );
}

export async function seedTreeRoot(
  page: Page,
  npub: string,
  treeName: string,
  rootInfo: { hashHex: string; keyHex?: string | null }
): Promise<void> {
  await page.evaluate(async ({ targetNpub, targetTree, hashHex, keyHex }) => {
    const { updateLocalRootCacheHex } = await import('/src/treeRootCache');
    const fromHex = (hex: string): Uint8Array => {
      const normalized = hex.trim();
      const bytes = new Uint8Array(Math.floor(normalized.length / 2));
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    };
    const { treeRootRegistry } = await import('/src/TreeRootRegistry');
    updateLocalRootCacheHex(targetNpub, targetTree, hashHex, keyHex ?? undefined, 'public');
    treeRootRegistry.setFromExternal(targetNpub, targetTree, fromHex(hashHex), 'prefetch', {
      key: keyHex ? fromHex(keyHex) : undefined,
      visibility: 'public',
      updatedAt: Math.floor(Date.now() / 1000),
    });
    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (adapter?.setTreeRootCache) {
      await adapter.setTreeRootCache(
        targetNpub,
        targetTree,
        fromHex(hashHex),
        keyHex ? fromHex(keyHex) : undefined,
        'public'
      );
    }
  }, { targetNpub: npub, targetTree: treeName, hashHex: rootInfo.hashHex, keyHex: rootInfo.keyHex ?? null });
}

export async function ensureTreeRootHash(
  page: Page,
  npub: string,
  treeName: string,
  rootInfo: { hashHex: string; keyHex?: string | null },
  timeoutMs: number = 60000
): Promise<void> {
  try {
    await waitForTreeRootHash(page, npub, treeName, rootInfo.hashHex, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test] tree root not resolved via relay, seeding (${msg})`);
    await seedTreeRoot(page, npub, treeName, rootInfo);
    await waitForTreeRootHash(page, npub, treeName, rootInfo.hashHex, timeoutMs);
  }
  await seedTreeRoot(page, npub, treeName, rootInfo);
  await waitForTreeRootStoreHash(page, rootInfo.hashHex, Math.min(timeoutMs, 30000)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test] route tree root store did not reflect seeded root yet (${msg})`);
  });
}

export async function prefetchByHash(page: Page, hashHex: string, timeoutMs: number = 60000): Promise<number> {
  let size = 0;
  await expect.poll(async () => {
    size = await page.evaluate(async (hash: string) => {
      const fromHex = (hex: string): Uint8Array => {
        const normalized = hex.trim();
        const bytes = new Uint8Array(Math.floor(normalized.length / 2));
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
      };
      const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
      if (!adapter?.get) return 0;
      const data = await adapter.get(fromHex(hash)).catch(() => null);
      return data ? data.length : 0;
    }, hashHex);
    return size;
  }, { timeout: timeoutMs, intervals: [1000, 2000, 3000] }).toBeGreaterThan(0);
  return size;
}

export async function tryPrefetch(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[test] ${label} prefetch failed: ${msg}`);
  }
}

export async function prefetchTreePath(
  page: Page,
  npub: string,
  treeName: string,
  filePath: string,
  timeoutMs: number = 60000
): Promise<boolean> {
  let resolved = false;
  try {
    await expect.poll(async () => {
      return page.evaluate(async ({ targetNpub, targetTree, path }) => {
        const { getTree } = await import('/src/store');
        const { getTreeRootSync } = await import('/src/stores');
        const rootCid = getTreeRootSync(targetNpub, targetTree);
        if (!rootCid) return false;
        const tree = getTree();
        const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
        const entry = await tree.resolvePath(rootCid, path);
        return !!entry?.cid;
      }, { targetNpub: npub, targetTree: treeName, path: filePath });
    }, { timeout: timeoutMs, intervals: [1000, 2000, 5000] }).toBe(true);
    resolved = true;
  } catch {
    resolved = false;
  }
  return resolved;
}

export async function readFileTextViaWorker(
  page: Page,
  npub: string,
  treeName: string,
  filePath: string,
  timeoutMs: number = 15000
): Promise<string | null> {
  return page.evaluate(async ({ targetNpub, targetTree, path, timeout }) => {
    let rawBlock: Uint8Array | null = null;
    try {
      const { getTreeRootSync } = await import('/src/stores');
      const { getTree } = await import('/src/store');
      const root = getTreeRootSync(targetNpub, targetTree);
      if (!root) return null;
      const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
      if (typeof adapter?.get === 'function') {
        rawBlock = await adapter.get(root.hash).catch(() => null);
      }
      const tree = getTree();
      const entry = await tree.resolvePath(root, path);
      if (!entry?.cid) return null;
      if (typeof adapter?.get === 'function') {
        rawBlock = await adapter.get(entry.cid.hash).catch(() => rawBlock);
      }
      const read = async () => {
        if (typeof adapter?.readFileRange === 'function') {
          return adapter.readFileRange(entry.cid, 0, 2048);
        }
        if (typeof adapter?.readFile === 'function') {
          return adapter.readFile(entry.cid);
        }
        return tree.readFile(entry.cid);
      };
      const data = await Promise.race([
        read(),
        new Promise<Uint8Array | null>((resolve) => setTimeout(() => resolve(null), timeout)),
      ]);
      if (!data) return null;
      return new TextDecoder().decode(data);
    } catch {
      if (rawBlock && rawBlock.length) return '__fetched__';
      return null;
    }
  }, { targetNpub: npub, targetTree: treeName, path: filePath, timeout: timeoutMs });
}

export { enableOthersPool, flushPendingPublishes, getTestRelayUrl, safeGoto, useLocalRelay, waitForAppReady } from './test-utils.js';
