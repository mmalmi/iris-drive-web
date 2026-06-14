/**
 * Local cache for tracking the most recent root hash for each tree
 *
 * This is now a thin wrapper over TreeRootRegistry, providing backward
 * compatibility for existing consumers.
 *
 * Key: "npub/treeName"
 *
 * @see TreeRootRegistry.ts for the underlying implementation
 */
import type { Hash, TreeVisibility } from '@hashtree/core';
import { fromHex } from '@hashtree/core';
import { treeRootRegistry } from './TreeRootRegistry';
import { parseRoute } from './utils/route';

/**
 * Initialize the publish function on the registry.
 * Called from workerInit.ts after worker initialization completes.
 * This ensures all dependencies (nostr, refResolver) are ready.
 */
export async function initializePublishFn(): Promise<void> {
  // Dynamic imports for modules that may cause circular dependencies
  const { getRefResolver } = await import('./refResolver');
  const { cid: makeCid, fromHex: hexToBytes } = await import('@hashtree/core');

  treeRootRegistry.setPublishFn(async (_npub, treeName, record) => {
    // Get the resolver
    const resolver = getRefResolver();
    if (!resolver.publish) return false;

    // Get npub from nostrStore (we need the current user's npub, not passed one)
    const { nostrStore } = await import('./nostr');
    const state = nostrStore.getState();
    if (!state.npub) return false;

    // For link-visible trees, get the linkKey from URL param
    let linkKey: Uint8Array | undefined;
    if (record.visibility === 'link-visible') {
      const route = parseRoute();
      let linkKeyHex = route.params.get('k') ?? undefined;

      // Fallback to locally stored link keys when URL does not include ?k=
      if (!linkKeyHex && state.npub) {
        const { getLinkKey, waitForLinkKeysCache } = await import('./stores/trees');
        linkKeyHex = getLinkKey(state.npub, treeName) ?? undefined;
        if (!linkKeyHex) {
          await waitForLinkKeysCache().catch(() => {});
          linkKeyHex = getLinkKey(state.npub, treeName) ?? undefined;
        }
      }

      if (linkKeyHex) {
        linkKey = hexToBytes(linkKeyHex);
      } else {
        // Do not publish a link-visible update without a stable link key.
        // Publishing without linkKey can rotate keys and break existing shared links.
        console.warn('[treeRootCache] Missing link key for link-visible publish', {
          treeName,
          npub: state.npub,
        });
        return false;
      }
    }

    const rootCid = makeCid(record.hash, record.key);
    const key = `${state.npub}/${treeName}`;

    // Call resolver.publish directly - this avoids the re-dirtying loop
    // that happens when going through saveHashtree -> updateLocalRootCache
    const result = await resolver.publish(key, rootCid, {
      visibility: record.visibility,
      linkKey,
      labels: record.labels,
    });

    return result?.success ?? false;
  });
}

// Re-export for backward compatibility
export interface CacheEntry {
  hash: Hash;
  key?: Hash;
  visibility?: TreeVisibility;
  labels?: string[];
  dirty: boolean;
}

/**
 * Subscribe to cache updates
 */
export function onCacheUpdate(listener: (npub: string, treeName: string) => void): () => void {
  return treeRootRegistry.subscribeAll((key, _record) => {
    const slashIndex = key.indexOf('/');
    if (slashIndex > 0) {
      const npub = key.slice(0, slashIndex);
      const treeName = key.slice(slashIndex + 1);
      listener(npub, treeName);
    }
  });
}

/**
 * Update the local root cache after a write operation.
 * Publishing to Nostr is throttled - multiple rapid updates result in one publish.
 */
export function updateLocalRootCache(
  npub: string,
  treeName: string,
  hash: Hash,
  key?: Hash,
  visibility?: TreeVisibility,
  labels?: string[]
): void {
  treeRootRegistry.setLocal(npub, treeName, hash, { key, visibility, labels });
}

/**
 * Get the visibility for a cached tree
 */
export function getCachedVisibility(npub: string, treeName: string): TreeVisibility | undefined {
  return treeRootRegistry.getVisibility(npub, treeName);
}

/**
 * Update the local root cache (hex version)
 */
export function updateLocalRootCacheHex(
  npub: string,
  treeName: string,
  hashHex: string,
  keyHex?: string,
  visibility?: TreeVisibility,
  labels?: string[]
): void {
  updateLocalRootCache(
    npub,
    treeName,
    fromHex(hashHex),
    keyHex ? fromHex(keyHex) : undefined,
    visibility,
    labels
  );
}

/**
 * Get cached root hash for a tree (if available)
 */
export function getLocalRootCache(npub: string, treeName: string): Hash | undefined {
  return treeRootRegistry.get(npub, treeName)?.hash;
}

/**
 * Get cached root key for a tree (if available)
 */
export function getLocalRootKey(npub: string, treeName: string): Hash | undefined {
  return treeRootRegistry.get(npub, treeName)?.key;
}

/**
 * Get all entries from the local root cache
 */
export function getAllLocalRoots(): Map<string, { hash: Hash; key?: Hash; visibility?: TreeVisibility; labels?: string[] }> {
  const result = new Map<string, { hash: Hash; key?: Hash; visibility?: TreeVisibility; labels?: string[] }>();
  for (const [key, record] of treeRootRegistry.getAllRecords().entries()) {
    result.set(key, {
      hash: record.hash,
      key: record.key,
      visibility: record.visibility,
      labels: record.labels,
    });
  }
  return result;
}

/**
 * Get full cache entry
 */
export function getLocalRootEntry(npub: string, treeName: string): CacheEntry | undefined {
  const record = treeRootRegistry.get(npub, treeName);
  if (!record) return undefined;

  return {
    hash: record.hash,
    key: record.key,
    visibility: record.visibility,
    labels: record.labels,
    dirty: record.dirty,
  };
}

/**
 * Cancel any pending publish for a tree (call before delete)
 * This prevents the throttled publish from "undeleting" the tree
 */
export function cancelPendingPublish(npub: string, treeName: string): void {
  treeRootRegistry.cancelPendingPublish(npub, treeName);
  treeRootRegistry.delete(npub, treeName);
}

/**
 * Force immediate publish (for critical operations like logout)
 */
export async function flushPendingPublishes(): Promise<void> {
  if (import.meta.env.VITE_TEST_MODE) {
    try {
      const { waitForRelayConnection } = await import('./lib/workerInit');
      await waitForRelayConnection(3000);
    } catch {
      // Ignore relay wait failures in test mode
    }
  }
  await treeRootRegistry.flushPendingPublishes();
}
