import { get } from 'svelte/store';
import type { Hash, RefResolverSubscriptionMetadata, SubscribeVisibilityInfo, TreeVisibility } from '@hashtree/core';
import { NDKEvent, type NDKFilter, type NDKSubscriptionOptions, NDKSubscriptionCacheUsage } from 'ndk';
import type { Event as NostrToolsEvent } from 'nostr-tools';
import { routeStore } from './route';
import { getRefResolver, getResolverKey } from '../refResolver';
import { driveRootDTag, KIND_DRIVE_ROOT, parseDriveRootEventForDevice } from '../drive/protocol';
import { syncNativeTreeRootCache } from '../lib/nativeTreeRootCache';
import {
  getTreeRootSubscriptionPlan,
  shouldStartTreeRootSubscription,
} from '../lib/treeRootSubscriptionPlan';
import { shouldWaitForLinkVisibleMetadata } from '../lib/treeRootRoutePolicy';
import { getSecretKey, ndk, useNostrStore, type NostrState } from '../nostr';
import { treeRootRegistry } from '../TreeRootRegistry';
import { isNostrIdentityId } from '../utils/route';
import {
  getVisibilityInfoFromRegistry,
  subscriptionState,
} from './treeRootShared';
import {
  WORKER_READY_TIMEOUT_MS,
  clearWorkerHydrateRetry,
  ensureWorkerTreeRootSubscription,
  hydrateTreeRootFromWorker,
  scheduleWorkerHydrateRetry,
  unsubscribeWorkerTreeRootSubscription,
  waitForWorkerReady,
} from './treeRootWorker';

const DRIVE_ROOT_BACKFILL_INTERVAL_MS = 3000;

/**
 * Update the subscription cache directly (called from feed subscriptions).
 * Keeps backward compatibility while updating the registry for UI consumers.
 */
export function updateSubscriptionCache(
  key: string,
  hash: Hash,
  encryptionKey?: Hash,
  options?: { updatedAt?: number; visibility?: TreeVisibility }
): void {
  const slashIndex = key.indexOf('/');
  if (slashIndex > 0 && slashIndex < key.length - 1) {
    const npub = key.slice(0, slashIndex);
    const treeName = key.slice(slashIndex + 1);
    const visibility = options?.visibility ?? treeRootRegistry.getVisibility(npub, treeName) ?? 'public';
    const updatedAt = options?.updatedAt ?? Math.floor(Date.now() / 1000);
    treeRootRegistry.setFromExternal(npub, treeName, hash, 'prefetch', {
      key: encryptionKey,
      visibility,
      updatedAt,
    });
    void syncNativeTreeRootCache(npub, treeName, { hash, key: encryptionKey }, visibility)
      .catch((error) => {
        console.warn('[treeRoot] Failed to sync native tree root cache:', error);
      });

  }

  let state = subscriptionState.get(key);
  if (!state) {
    // Create entry if it doesn't exist (for newly created trees)
    state = {
      decryptedKey: undefined,
      listeners: new Set(),
      unsubscribeResolver: null,
      unsubscribeWorker: null,
      workerHydrateRetryTimer: null,
    };
    subscriptionState.set(key, state);
  }
  state.decryptedKey = encryptionKey;
  const visibilityInfo = getVisibilityInfoFromRegistry(key);
  state.listeners.forEach(listener => listener(hash, encryptionKey, visibilityInfo, {
    updatedAt: options?.updatedAt ?? Math.floor(Date.now() / 1000),
  }));
}

async function applyDriveRootEvent(
  key: string,
  rootScopeId: string,
  driveId: string,
  event: NostrToolsEvent,
): Promise<void> {
  const secretKey = getSecretKey();
  if (!secretKey) return;

  let parsed;
  try {
    parsed = parseDriveRootEventForDevice(event, secretKey);
  } catch (error) {
    console.warn('[treeRoot] Ignoring unreadable NostrIdentity drive root:', error);
    return;
  }

  if (parsed.root_scope_id !== rootScopeId || parsed.drive_id !== driveId) return;

  const entry = subscriptionState.get(key);
  if (!entry) return;

  const visibilityInfo: SubscribeVisibilityInfo = { visibility: 'private' };
  const apply = () => treeRootRegistry.setFromResolver(rootScopeId, driveId, parsed.root.hash, parsed.published_at, {
    key: parsed.root.key,
    visibility: 'private',
    labels: ['iris-drive'],
  });
  let updated = apply();
  if (!updated && treeRootRegistry.getByKey(key)?.dirty) {
    await treeRootRegistry.flushPendingPublishes();
    updated = apply();
  }
  if (!updated) return;

  entry.decryptedKey = parsed.root.key;
  entry.listeners.forEach(listener => listener(parsed.root.hash, parsed.root.key, visibilityInfo, {
    updatedAt: parsed.published_at,
    eventId: event.id,
  }));
}

function rawNdkEvent(event: NDKEvent): NostrToolsEvent | null {
  const rawEvent = event.rawEvent() as Partial<NostrToolsEvent>;
  if (!rawEvent.id || !rawEvent.sig || !rawEvent.pubkey || !rawEvent.tags || typeof rawEvent.kind !== 'number') {
    return null;
  }
  return rawEvent as NostrToolsEvent;
}

function backfillDriveRootScope(key: string, rootScopeId: string, driveId: string): void {
  const filter: NDKFilter = {
    kinds: [KIND_DRIVE_ROOT],
    '#d': [driveRootDTag(rootScopeId, driveId)],
    limit: 50,
  };
  void ndk.fetchEvents(filter)
    .then(async (events) => {
      for (const event of events) {
        const rawEvent = rawNdkEvent(event);
        if (rawEvent) await applyDriveRootEvent(key, rootScopeId, driveId, rawEvent);
      }
    })
    .catch((error) => {
      console.warn('[treeRoot] Failed to backfill NostrIdentity drive roots:', error);
    });
}

function driveRootScopeFromResolverKey(key: string): { rootScopeId: string; driveId: string } | null {
  const slashIndex = key.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= key.length - 1) return null;
  const rootScopeId = key.slice(0, slashIndex);
  if (!isNostrIdentityId(rootScopeId)) return null;
  return {
    rootScopeId,
    driveId: key.slice(slashIndex + 1),
  };
}

export function refreshDriveRootResolverKey(key: string): void {
  const scope = driveRootScopeFromResolverKey(key);
  if (!scope) return;
  backfillDriveRootScope(key, scope.rootScopeId, scope.driveId);
}

function subscribeToDriveRootScope(key: string, rootScopeId: string, driveId: string): () => void {
  const filter: NDKFilter = {
    kinds: [KIND_DRIVE_ROOT],
    '#d': [driveRootDTag(rootScopeId, driveId)],
  };
  const opts: NDKSubscriptionOptions = {
    closeOnEose: false,
    cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
  };

  const attachSub = () => {
    const sub = ndk.subscribe(filter, opts);
    sub.on('event', (event: NDKEvent) => {
      const rawEvent = rawNdkEvent(event);
      if (rawEvent) void applyDriveRootEvent(key, rootScopeId, driveId, rawEvent);
    });
    return sub;
  };

  let sub = attachSub();
  const fetchSnapshot = () => backfillDriveRootScope(key, rootScopeId, driveId);
  fetchSnapshot();
  const backfillTimer = window.setInterval(fetchSnapshot, DRIVE_ROOT_BACKFILL_INTERVAL_MS);
  let lastConnectedRelays = useNostrStore.getState().connectedRelays;
  const relayUnsub = useNostrStore.subscribe((state: NostrState) => {
    if (state.connectedRelays > 0 && lastConnectedRelays === 0) {
      try {
        sub.stop();
      } catch {
        // ignore
      }
      sub = attachSub();
      fetchSnapshot();
    }
    lastConnectedRelays = state.connectedRelays;
  });

  return () => {
    window.clearInterval(backfillTimer);
    relayUnsub?.();
    sub.stop();
  };
}


/**
 * Start the resolver subscription after worker is ready
 * This is called asynchronously to ensure NDK transport plugin is registered
 */
async function startResolverSubscription(
  key: string,
  options?: { force?: boolean; skipWorkerHydrate?: boolean }
): Promise<void> {
  const state = subscriptionState.get(key);
  if (!state) return; // Entry was deleted before worker was ready

  // Don't create subscription if one already exists unless forced
  if (state.unsubscribeResolver || state.unsubscribeWorker) {
    if (!options?.force) return;
    state.unsubscribeResolver?.();
    state.unsubscribeResolver = null;
    state.unsubscribeWorker?.();
    state.unsubscribeWorker = null;
    clearWorkerHydrateRetry(key);
  }

  const slashIndex = key.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= key.length - 1) return;
  const npub = key.slice(0, slashIndex);
  const treeName = key.slice(slashIndex + 1);

  if (isNostrIdentityId(npub)) {
    state.unsubscribeResolver = subscribeToDriveRootScope(key, npub, treeName);
    return;
  }

  const workerReady = await Promise.race([
    waitForWorkerReady().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), WORKER_READY_TIMEOUT_MS)),
  ]);
  if (!workerReady) {
    console.warn('[treeRoot] Worker not ready yet - subscribing anyway');
  }

  const currentRoute = get(routeStore);
  const hasRouteLinkKey = getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined) === key
    && !!currentRoute.params.get('k');

  const subscribed = await ensureWorkerTreeRootSubscription(npub);
  const hydrated = options?.skipWorkerHydrate
    ? false
    : await hydrateTreeRootFromWorker(npub, treeName);
  const subscriptionPlan = getTreeRootSubscriptionPlan({
    workerSubscribed: subscribed,
    workerHydrated: hydrated,
    hasRouteLinkKey,
  });

  if (subscriptionPlan.attachWorkerSubscription) {
    state.unsubscribeWorker = () => {
      void unsubscribeWorkerTreeRootSubscription(npub);
    };
    if (!hydrated) {
      scheduleWorkerHydrateRetry(key, npub, treeName, options);
    }
  }

  if (!subscriptionPlan.useResolverSubscription) {
    return;
  }

  const resolver = getRefResolver();
  state.unsubscribeResolver = resolver.subscribe(key, (resolvedCid, visibilityInfo, metadata) => {
    const entry = subscriptionState.get(key);
    if (entry) {
      // Update registry with resolver data (only if newer)
      if (resolvedCid?.hash) {
        const updatedAt = getResolverUpdatedAt(metadata);

        treeRootRegistry.setFromResolver(npub, treeName, resolvedCid.hash, updatedAt, {
          key: resolvedCid.key,
          visibility: visibilityInfo?.visibility ?? 'public',
          labels: treeRootRegistry.getLabels(npub, treeName),
          encryptedKey: visibilityInfo?.encryptedKey,
          keyId: visibilityInfo?.keyId,
          selfEncryptedKey: visibilityInfo?.selfEncryptedKey,
          selfEncryptedLinkKey: visibilityInfo?.selfEncryptedLinkKey,
        });
      }

      entry.listeners.forEach(listener => listener(
        resolvedCid?.hash ?? null,
        resolvedCid?.key,
        visibilityInfo,
        metadata,
      ));
    }
  });

  void waitForWorkerReady().then(async () => {
    const active = subscriptionState.get(key);
    if (!active || active.unsubscribeWorker) return;
    const subscribed = await ensureWorkerTreeRootSubscription(npub);
    const hydrated = options?.skipWorkerHydrate
      ? false
      : await hydrateTreeRootFromWorker(npub, treeName);
    const retryPlan = getTreeRootSubscriptionPlan({
      workerSubscribed: subscribed,
      workerHydrated: hydrated,
      hasRouteLinkKey,
    });
    if (retryPlan.attachWorkerSubscription) {
      active.unsubscribeWorker = () => {
        void unsubscribeWorkerTreeRootSubscription(npub);
      };
      if (!hydrated) {
        scheduleWorkerHydrateRetry(key, npub, treeName, options);
      }
    }
  });
}

export function getResolverUpdatedAt(metadata?: RefResolverSubscriptionMetadata): number {
  return metadata?.updatedAt ?? Math.floor(Date.now() / 1000);
}

export function subscribeToResolver(
  key: string,
  callback: (
    hash: Hash | null,
    encryptionKey?: Hash,
    visibilityInfo?: SubscribeVisibilityInfo,
    metadata?: RefResolverSubscriptionMetadata
  ) => void
): () => void {
  let state = subscriptionState.get(key);
  const hadState = !!state;

  if (!state) {
    state = {
      decryptedKey: undefined,
      listeners: new Set(),
      unsubscribeResolver: null,
      unsubscribeWorker: null,
      workerHydrateRetryTimer: null,
    };
    subscriptionState.set(key, state);
  }

  if (shouldStartTreeRootSubscription({
    hasState: hadState,
    hasResolverSubscription: !!state.unsubscribeResolver,
    hasWorkerSubscription: !!state.unsubscribeWorker,
  })) {
    // Start or restart the subscription asynchronously after worker is ready.
    // Cached state entries are retained even when listeners drop to zero, so we
    // must restart the underlying subscriptions when a new consumer arrives.
    startResolverSubscription(key);
  }

  state.listeners.add(callback);

  // Emit current snapshot from registry if available
  const record = treeRootRegistry.getByKey(key);
  if (record) {
    const visibilityInfo = getVisibilityInfoFromRegistry(key);
    const currentRoute = get(routeStore);
    const hasRouteLinkKey = getResolverKey(currentRoute.npub ?? undefined, currentRoute.treeName ?? undefined) === key
      && !!currentRoute.params.get('k');
    const state = subscriptionState.get(key);

    if (!shouldWaitForLinkVisibleMetadata({
      visibility: record.visibility,
      hasRouteLinkKey,
      hasEncryptedKey: !!visibilityInfo?.encryptedKey,
      hasSessionDecryptedKey: !!state?.decryptedKey,
    })) {
      queueMicrotask(() => callback(record.hash, record.key, visibilityInfo, { updatedAt: record.updatedAt }));
    }
  }

  return () => {
    const cached = subscriptionState.get(key);
    if (cached) {
      cached.listeners.delete(callback);
      // Note: We don't delete the cache entry when the last listener unsubscribes
      // because the data is still valid and may be needed by other components
      // (e.g., DocCard uses getTreeRootSync after the editor unmounts)
      if (cached.listeners.size === 0) {
        cached.unsubscribeResolver?.();
        cached.unsubscribeResolver = null;
        cached.unsubscribeWorker?.();
        cached.unsubscribeWorker = null;
        clearWorkerHydrateRetry(key);
        // Keep the cached data, just stop the subscription
        // subscriptionState.delete(key);
      }
    }
  };
}

export function subscribeToTreeRoot(
  npub: string | null | undefined,
  treeName: string | null | undefined,
  callback: (
    hash: Hash | null,
    encryptionKey?: Hash,
    visibilityInfo?: SubscribeVisibilityInfo,
    metadata?: RefResolverSubscriptionMetadata
  ) => void
): () => void {
  const key = getResolverKey(npub ?? undefined, treeName ?? undefined);
  if (!key) return () => {};
  return subscribeToResolver(key, callback);
}

export function refreshResolverSubscription(
  key: string,
  options?: { skipWorkerHydrate?: boolean }
): void {
  if (!subscriptionState.has(key)) return;
  startResolverSubscription(key, { force: true, skipWorkerHydrate: options?.skipWorkerHydrate });
}
