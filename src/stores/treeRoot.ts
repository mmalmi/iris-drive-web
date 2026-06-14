/**
 * Tree root store for Svelte
 *
 * This provides the rootCid from the URL via resolver subscription:
 * - For tree routes (/npub/treeName/...), subscribes to the resolver
 * - For permalink routes (/nhash1.../...), extracts hash directly from URL
 * - Returns null when no tree context
 *
 * Data flow:
 * - Local writes -> TreeRootRegistry (via treeRootCache.ts)
 * - Web: worker tree-root events -> TreeRootRegistry (via setFromWorker)
 * - Tauri: resolver events -> TreeRootRegistry (via setFromResolver)
 * - UI reads -> TreeRootRegistry (via get/resolve)
 */
import { get, type Readable } from 'svelte/store';
import { toHex, cid } from '@hashtree/core';
import type {
  CID,
  Hash,
} from '@hashtree/core';
import { routeStore, parseRouteFromHash } from './route';
import { getResolverKey } from '../refResolver';
import { nostrStore, type NostrState } from '../nostr';
import { logHtreeDebug } from '../lib/htreeDebug';
import { shouldWaitForLinkVisibleMetadata } from '../lib/treeRootRoutePolicy';
import { treeRootRegistry } from '../TreeRootRegistry';
import { permalinkSnapshotStore, getPermalinkSnapshotSync, isSnapshotPermalinkSync } from './permalinkSnapshot';
import {
  getNostrState,
  getVisibilityInfoFromRegistry,
  subscriptionState,
  treeRootStore,
  workerKeyMergeCache,
  workerRootCacheSync,
} from './treeRootShared';
import {
  decryptEncryptionKey,
  recoverLinkKeyForUrl,
  recoverMissingLinkKeyForOwner,
} from './treeRootKeys';
import {
  getResolverUpdatedAt,
  refreshResolverSubscription,
  subscribeToResolver,
  subscribeToTreeRoot,
} from './treeRootResolver';
import {
  mergeTreeRootKeyToWorker,
  syncResolvedTreeRootToWorker,
} from './treeRootWorker';

export { signalWorkerReady } from './treeRootWorker';
export { treeRootStore } from './treeRootShared';
export { subscribeToTreeRoot, updateSubscriptionCache } from './treeRootResolver';

async function syncActiveTreeRootFromRecord(
  key: string,
  record: ReturnType<typeof treeRootRegistry.getByKey>,
  state: {
    decryptedKey: Hash | undefined;
  } | undefined
): Promise<void> {
  if (!record) return;
  if (key !== activeResolverKey) return;

  const currentRoute = get(routeStore);
  if (key !== getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined)) return;

  let effectiveKey = record.key ?? state?.decryptedKey;
  if (!effectiveKey && record.visibility === 'link-visible') {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    const linkKeyFromUrl = currentRoute.params.get('k');
    if (shouldWaitForLinkVisibleMetadata({
      visibility: record.visibility,
      hasRouteLinkKey: !!linkKeyFromUrl,
      hasEncryptedKey: !!visibilityInfo?.encryptedKey,
      hasSessionDecryptedKey: !!state?.decryptedKey,
    })) {
      return;
    }
    const decryptedKey = await decryptEncryptionKey(visibilityInfo, undefined, linkKeyFromUrl);
    if (decryptedKey && state) {
      state.decryptedKey = decryptedKey;
    }
    effectiveKey = decryptedKey ?? effectiveKey;
  }

  if (record.visibility === 'link-visible' && !effectiveKey) return;

  treeRootStore.set(cid(record.hash, effectiveKey));
  logHtreeDebug('treeRoot:set', { source: 'registry-active', resolverKey: key });
}

// Subscribe to registry updates to notify listeners
treeRootRegistry.subscribeAll((key, record) => {
  if (!record) {
    workerRootCacheSync.delete(key);
    return;
  }
  const state = subscriptionState.get(key);
  if (state) {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    state.listeners.forEach(listener => listener(record.hash, record.key, visibilityInfo, {
      updatedAt: record.updatedAt,
    }));
  }
  void syncActiveTreeRootFromRecord(key, record, state);
  void syncResolvedTreeRootToWorker(key, record);
});

// Active subscription cleanup
let activeUnsubscribe: (() => void) | null = null;
let activeResolverKey: string | null = null;
let resolverRetryTimer: ReturnType<typeof setTimeout> | null = null;
let resolverRetryAttempts = 0;
const RESOLVER_RETRY_DELAY_MS = 2000;
const RESOLVER_RETRY_MAX_ATTEMPTS = 5;

function resetResolverRetry(): void {
  if (resolverRetryTimer) {
    clearTimeout(resolverRetryTimer);
    resolverRetryTimer = null;
  }
  resolverRetryAttempts = 0;
}

function scheduleResolverRetry(resolverKey: string): void {
  if (resolverRetryTimer) return;
  if (getNostrState().connectedRelays === 0) return;

  resolverRetryTimer = setTimeout(() => {
    resolverRetryTimer = null;
    if (resolverKey !== activeResolverKey) return;

    // Check registry instead of subscriptionCache
    const record = treeRootRegistry.getByKey(resolverKey);
    if (record?.hash) {
      resetResolverRetry();
      return;
    }

    resolverRetryAttempts += 1;
    refreshResolverSubscription(resolverKey);

    if (resolverRetryAttempts < RESOLVER_RETRY_MAX_ATTEMPTS) {
      scheduleResolverRetry(resolverKey);
    }
  }, RESOLVER_RETRY_DELAY_MS);
}

/**
 * Create a tree root store that reacts to route changes
 */
export function createTreeRootStore(): Readable<CID | null> {
  // Subscribe to route changes
  routeStore.subscribe(async (route) => {
    logHtreeDebug('treeRoot:route', {
      npub: route.npub,
      treeName: route.treeName,
      isPermalink: route.isPermalink,
      path: route.path?.join('/') ?? '',
      hasCid: !!route.cid,
    });
    // For permalinks, use CID from route (already Uint8Array from nhashDecode)
    if (route.isPermalink && route.cid) {
      if (isSnapshotPermalinkSync(route)) {
        treeRootStore.set(getPermalinkSnapshotSync().rootCid);
        logHtreeDebug('treeRoot:set', { source: 'snapshot-permalink' });
      } else {
        treeRootStore.set(route.cid);
        logHtreeDebug('treeRoot:set', { source: 'permalink' });
      }

      // Cleanup any active subscription
      if (activeUnsubscribe) {
        activeUnsubscribe();
        activeUnsubscribe = null;
        activeResolverKey = null;
      }
      resetResolverRetry();
      return;
    }

    // For tree routes, subscribe to resolver
    const resolverKey = getResolverKey(route.npub ?? undefined, route.treeName ?? undefined);
    if (!resolverKey) {
      treeRootStore.set(null);
      logHtreeDebug('treeRoot:clear', { reason: 'no-resolver-key' });
      if (activeUnsubscribe) {
        activeUnsubscribe();
        activeUnsubscribe = null;
        activeResolverKey = null;
      }
      resetResolverRetry();
      return;
    }

    // Same key, no need to resubscribe
    // But still check if we need to recover k= param for URL, and restore the
    // store from the registry snapshot if a same-tree navigation cleared it.
    if (resolverKey === activeResolverKey) {
      const cachedRoot = getTreeRootSync(route.npub, route.treeName);
      const cachedRecord = treeRootRegistry.getByKey(resolverKey);
      const cachedState = subscriptionState.get(resolverKey);
      const shouldUseCachedRoot = !!cachedRoot && !shouldWaitForLinkVisibleMetadata({
        visibility: cachedRecord?.visibility,
        hasRouteLinkKey: !!route.params.get('k'),
        hasEncryptedKey: !!cachedRecord?.encryptedKey,
        hasSessionDecryptedKey: !!cachedState?.decryptedKey,
      });
      if (shouldUseCachedRoot && !get(treeRootStore)) {
        treeRootStore.set(cachedRoot);
        logHtreeDebug('treeRoot:set', { source: 'registry-reuse', resolverKey });
      }
      const currentRoute = get(routeStore);
      const linkKeyFromUrl = currentRoute.params.get('k');
      if (!linkKeyFromUrl) {
        recoverLinkKeyForUrl(resolverKey);
      }
      logHtreeDebug('treeRoot:reuse', { resolverKey });
      return;
    }

    // Cleanup previous subscription
    if (activeUnsubscribe) {
      activeUnsubscribe();
    }

    // Reset while waiting for new data
    treeRootStore.set(null);
    activeResolverKey = resolverKey;
    resetResolverRetry();
    logHtreeDebug('treeRoot:subscribe', { resolverKey });
    logHtreeDebug('treeRoot:subscribe', { resolverKey });

    // Use cached registry value immediately if available (offline-first / test stability)
    const cachedRoot = getTreeRootSync(route.npub, route.treeName);
    const cachedRecord = treeRootRegistry.getByKey(resolverKey);
    const cachedState = subscriptionState.get(resolverKey);
    const shouldUseCachedRoot = !!cachedRoot && !shouldWaitForLinkVisibleMetadata({
      visibility: cachedRecord?.visibility,
      hasRouteLinkKey: !!route.params.get('k'),
      hasEncryptedKey: !!cachedRecord?.encryptedKey,
      hasSessionDecryptedKey: !!cachedState?.decryptedKey,
    });
    if (shouldUseCachedRoot) {
      treeRootStore.set(cachedRoot);
      logHtreeDebug('treeRoot:set', { source: 'registry' });
    }

    // Subscribe to resolver
    activeUnsubscribe = subscribeToResolver(resolverKey, async (hash, encryptionKey, visibilityInfo, metadata) => {
      if (!hash) {
        const fallbackRoot = getTreeRootSync(route.npub, route.treeName);
        if (fallbackRoot) {
          treeRootStore.set(fallbackRoot);
          logHtreeDebug('treeRoot:set', { source: 'registry-fallback', resolverKey });
        } else {
          treeRootStore.set(null);
          logHtreeDebug('treeRoot:clear', { reason: 'no-hash', resolverKey });
        }
        return;
      }

      const updatedAt = getResolverUpdatedAt(metadata);

      logHtreeDebug('treeRoot:resolver', {
        resolverKey,
        hasHash: !!hash,
        hasEncryptionKey: !!encryptionKey,
        visibility: visibilityInfo?.visibility ?? null,
        hasEncryptedKey: !!visibilityInfo?.encryptedKey,
        updatedAt,
      });

      // Get current route params (not the closure-captured route from subscription time)
      const currentRoute = get(routeStore);
      const linkKeyFromUrl = currentRoute.params.get('k');
      const decryptedKey = await decryptEncryptionKey(visibilityInfo, encryptionKey, linkKeyFromUrl);
      const cachedState = subscriptionState.get(resolverKey);
      const effectiveKey = decryptedKey ?? cachedState?.decryptedKey;

      // Cache the decrypted key
      if (effectiveKey && cachedState) {
        cachedState.decryptedKey = effectiveKey;
      }

      resetResolverRetry();

      // Link-visible owner URL recovery/migration
      if (!linkKeyFromUrl) {
        await recoverMissingLinkKeyForOwner({ resolverKey, visibilityInfo, hash, decryptedKey });
      }

      // For link-visible content, don't set store until we have the decryption key
      // This prevents the video player from trying to load before decryption is possible
      const visibility = visibilityInfo?.visibility;

      // If we have k= param but no visibilityInfo yet, wait for resolver to fetch the event
      // (we need encryptedKey from event to XOR with linkKey)
      // BUT: if we already have encryptionKey from local cache (owner just created tree),
      // we can proceed without waiting for visibilityInfo
      if (linkKeyFromUrl && !visibilityInfo?.encryptedKey && !encryptionKey && !effectiveKey) {
        logHtreeDebug('treeRoot:wait-encrypted-key', { resolverKey });
        return;
      }

      if (visibility === 'link-visible' && !effectiveKey) {
        logHtreeDebug('treeRoot:wait-decrypted-key', { resolverKey });
        // Don't set the store - wait for next callback with key
        return;
      }

      const slashIndex = resolverKey.indexOf('/');
      const resolverNpub = slashIndex > 0 ? resolverKey.slice(0, slashIndex) : null;
      const resolverTreeName = slashIndex > 0 && slashIndex < resolverKey.length - 1
        ? resolverKey.slice(slashIndex + 1)
        : null;

      if (effectiveKey && resolverNpub && resolverTreeName && (encryptionKey || visibilityInfo?.encryptedKey)) {
        treeRootRegistry.setFromResolver(resolverNpub, resolverTreeName, hash, updatedAt, {
          key: effectiveKey,
          visibility: visibilityInfo?.visibility ?? treeRootRegistry.getVisibility(resolverNpub, resolverTreeName) ?? 'public',
          labels: treeRootRegistry.getLabels(resolverNpub, resolverTreeName),
          encryptedKey: visibilityInfo?.encryptedKey,
          keyId: visibilityInfo?.keyId,
          selfEncryptedKey: visibilityInfo?.selfEncryptedKey,
          selfEncryptedLinkKey: visibilityInfo?.selfEncryptedLinkKey,
        });
      }

      // Set the store FIRST so UI updates immediately
      treeRootStore.set(cid(hash, effectiveKey));
      logHtreeDebug('treeRoot:set', {
        resolverKey,
        visibility: visibility ?? null,
        hasDecryptedKey: !!effectiveKey,
      });

      // Then merge key to registry and worker in the background (don't block UI)
      if (resolverNpub && resolverTreeName) {
        if (effectiveKey) {
          treeRootRegistry.mergeKey(resolverNpub, resolverTreeName, hash, effectiveKey);
          const signature = `${toHex(hash)}:${toHex(effectiveKey)}`;
          if (workerKeyMergeCache.get(resolverKey) !== signature) {
            // Fire and forget - don't await, let it run in background
            void mergeTreeRootKeyToWorker(resolverNpub, resolverTreeName, hash, effectiveKey).then((merged) => {
              if (merged) {
                workerKeyMergeCache.set(resolverKey, signature);
              }
            });
          }
        }
      }
    });

    scheduleResolverRetry(resolverKey);
  });

  let lastConnectedRelays = getNostrState().connectedRelays;
  nostrStore.subscribe((state: NostrState) => {
    const connected = state.connectedRelays;
    if (connected > 0 && lastConnectedRelays === 0 && activeResolverKey) {
      const record = treeRootRegistry.getByKey(activeResolverKey);
      if (!record?.hash) {
        refreshResolverSubscription(activeResolverKey);
        scheduleResolverRetry(activeResolverKey);
      }
    }
    lastConnectedRelays = connected;
  });

  return treeRootStore;
}

/**
 * Get the current root CID synchronously
 */
export function getTreeRootSync(npub: string | null | undefined, treeName: string | null | undefined): CID | null {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return null;

  // Check registry first
  const record = treeRootRegistry.getByKey(key);
  if (record?.hash) {
    if (record.key) {
      return cid(record.hash, record.key);
    }
    const state = subscriptionState.get(key);
    if (state?.decryptedKey) {
      return cid(record.hash, state.decryptedKey);
    }
    return cid(record.hash);
  }

  // Fallback to subscription state for decrypted key
  const state = subscriptionState.get(key);
  if (state?.decryptedKey && record?.hash) {
    return cid(record.hash, state.decryptedKey);
  }

  return null;
}

async function resolveTreeRootWithLinkKey(
  key: string,
  linkKey: string | null = null
): Promise<CID | null> {
  const record = treeRootRegistry.getByKey(key);
  if (!record?.hash) return null;

  const state = subscriptionState.get(key);
  const visibilityInfo = getVisibilityInfoFromRegistry(key);
  let effectiveKey = record.key ?? state?.decryptedKey;

  if (!effectiveKey && (linkKey || visibilityInfo?.selfEncryptedKey || visibilityInfo?.selfEncryptedLinkKey)) {
    const decryptedKey = await decryptEncryptionKey(visibilityInfo, undefined, linkKey);
    if (decryptedKey) {
      const slashIndex = key.indexOf('/');
      if (slashIndex > 0 && slashIndex < key.length - 1) {
        const npub = key.slice(0, slashIndex);
        const treeName = key.slice(slashIndex + 1);
        treeRootRegistry.mergeKey(npub, treeName, record.hash, decryptedKey);
      }
      if (state) {
        state.decryptedKey = decryptedKey;
      }
      effectiveKey = decryptedKey;
    }
  }

  if ((visibilityInfo?.visibility ?? record.visibility) === 'link-visible' && !effectiveKey) {
    return null;
  }

  return cid(record.hash, effectiveKey);
}

export async function getTreeRoot(
  npub: string | null | undefined,
  treeName: string | null | undefined,
  linkKey: string | null = null
): Promise<CID | null> {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return null;

  if (!linkKey) {
    return getTreeRootSync(npub, treeName);
  }

  return resolveTreeRootWithLinkKey(key, linkKey);
}

/**
 * Wait for tree root to be resolved (async version of getTreeRootSync)
 * Subscribes to the resolver and waits for the first non-null result or timeout
 */
export function waitForTreeRoot(
  npub: string,
  treeName: string,
  timeoutMs: number = 10000,
  linkKey: string | null = null
): Promise<CID | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let unsub: (() => void) | null = null;
    const finish = (value: CID | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      unsub?.();
      resolve(value);
    };

    const maybeResolve = async (hash: Hash | null, encryptionKey?: Hash) => {
      if (!hash || resolved) return;
      if (encryptionKey) {
        finish(cid(hash, encryptionKey));
        return;
      }

      const hydrated = await getTreeRoot(npub, treeName, linkKey);
      if (hydrated) {
        finish(hydrated);
        return;
      }

      if (treeRootRegistry.getVisibility(npub, treeName) === 'link-visible') {
        return;
      }

      finish(cid(hash));
    };

    const timeout = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    void getTreeRoot(npub, treeName, linkKey).then((root) => {
      if (root) {
        finish(root);
      }
    });

    unsub = subscribeToTreeRoot(npub, treeName, (hash, encryptionKey) => {
      void maybeResolve(hash, encryptionKey);
    });
  });
}

/**
 * Invalidate and refresh the cached root CID
 */
export async function invalidateTreeRoot(npub: string | null | undefined, treeName: string | null | undefined): Promise<void> {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return;
  if (npub && treeName) {
    treeRootRegistry.delete(npub, treeName);
  }
  workerKeyMergeCache.delete(key);
  workerRootCacheSync.delete(key);

  if (activeResolverKey === key) {
    treeRootStore.set(null);
  }

  refreshResolverSubscription(key, { skipWorkerHydrate: true });
  scheduleResolverRetry(key);
}

// Synchronously parse initial permalink (no resolver needed for nhash URLs)
// This must run BEFORE currentDirHash.ts subscribes to avoid race condition
function initializePermalink(): void {
  if (typeof window === 'undefined') return;

  const route = parseRouteFromHash(window.location.hash);
  if (route.isPermalink && route.cid && !isSnapshotPermalinkSync(route)) {
    // route.cid is already a CID with Uint8Array fields from nhashDecode
    treeRootStore.set(route.cid);
  }
}

// Initialize permalink synchronously (before currentDirHash subscribes)
initializePermalink();

permalinkSnapshotStore.subscribe((state) => {
  const route = get(routeStore);
  if (!isSnapshotPermalinkSync(route)) {
    return;
  }
  treeRootStore.set(state.rootCid);
});

// Initialize the store once - guard against HMR re-initialization
// Store the flag on a global to persist across HMR module reloads
const HMR_KEY = '__treeRootStoreInitialized';
const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;

// Use queueMicrotask to defer until after module initialization completes
// This avoids circular dependency issues with nostr.ts -> store.ts
queueMicrotask(() => {
  if ((globalObj as Record<string, unknown>)[HMR_KEY]) return;
  (globalObj as Record<string, unknown>)[HMR_KEY] = true;
  createTreeRootStore();
});
