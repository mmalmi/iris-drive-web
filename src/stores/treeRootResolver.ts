import { get } from 'svelte/store';
import { toHex, type Hash, type RefResolverSubscriptionMetadata, type SubscribeVisibilityInfo, type TreeVisibility } from '@hashtree/core';
import type { Event, Filter } from 'nostr-tools';
import type { Event as NostrToolsEvent } from 'nostr-tools';
import { routeStore } from './route';
import { getRefResolver, getResolverKey } from '../refResolver';
import {
  driveRootDTag,
  KIND_DRIVE_ROOT,
  parseDriveRootEventForDevice,
  projectNostrIdentityRoster,
} from '../drive/protocol';
import { profileDriveProjection } from '../drive/profileDriveProjection';
import {
  driveRootAuthorizationFingerprint,
  driveRootBackfillFilters,
  isActiveDriveRootScopeSession,
  isAuthorizedDriveRootScopeSession,
  shouldResetDriveRootProjection,
} from '../lib/driveRootResolverPolicy';
import { syncNativeTreeRootCache } from '../lib/nativeTreeRootCache';
import {
  getTreeRootSubscriptionPlan,
  shouldStartTreeRootSubscription,
} from '../lib/treeRootSubscriptionPlan';
import { shouldWaitForLinkVisibleMetadata } from '../lib/treeRootRoutePolicy';
import {
  getCurrentNostrIdentitySession,
  getSecretKey,
  nostr,
  useNostrStore,
  type NostrState,
} from '../nostr';
import { getTree } from '../store';
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
const DRIVE_ROOT_MATERIALIZE_TIMEOUT_MS = 20_000;
const DRIVE_ROOT_LOCAL_PUBLISH_WAIT_TIMEOUT_MS = 20_000;
const DRIVE_ROOT_LOCAL_PUBLISH_POLL_INTERVAL_MS = 25;
type ProjectionRebuildWaiter = {
  resolve: (applied: boolean) => void;
  reject: (error: unknown) => void;
};
type ProjectionRebuildState = {
  requested: number;
  running: boolean;
  retryPending: boolean;
  authorizationFingerprint?: string;
  waiters: ProjectionRebuildWaiter[];
};
type DriveRootAuthorization = {
  active: boolean;
  appKeys: Set<string>;
  fingerprint: string;
};
const projectionRebuildState = new Map<string, ProjectionRebuildState>();

function projectionState(key: string): ProjectionRebuildState {
  let state = projectionRebuildState.get(key);
  if (!state) {
    state = {
      requested: 0,
      running: false,
      retryPending: false,
      waiters: [],
    };
    projectionRebuildState.set(key, state);
  }
  return state;
}

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
    if (isNostrIdentityId(npub) && !hasActiveDriveRootScope(npub)) {
      treeRootRegistry.delete(npub, treeName);
      return;
    }
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

function driveRootAuthorization(rootScopeId: string): DriveRootAuthorization {
  const session = getCurrentNostrIdentitySession();
  if (!isActiveDriveRootScopeSession(rootScopeId, session)) {
    return { active: false, appKeys: new Set(), fingerprint: 'inactive' };
  }
  try {
    const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
    const activeAppKeys = new Set(Object.entries(projection.active_facets)
      .filter(([, facet]) => facet.purposes?.includes('app_key'))
      .map(([pubkey]) => pubkey));
    const appKeys = new Set(Object.entries(projection.active_facets)
      .filter(([pubkey, facet]) => (
        activeAppKeys.has(pubkey)
        && facet.capabilities?.can_write_roots
      ))
      .map(([pubkey]) => pubkey));
    return {
      active: isAuthorizedDriveRootScopeSession(rootScopeId, session, activeAppKeys),
      appKeys,
      fingerprint: driveRootAuthorizationFingerprint(session, appKeys),
    };
  } catch (error) {
    console.warn('[treeRoot] Could not project Drive roster for root authorization:', error);
    return { active: false, appKeys: new Set(), fingerprint: 'invalid' };
  }
}

export function hasActiveDriveRootScope(rootScopeId: string): boolean {
  return driveRootAuthorization(rootScopeId).active;
}

export function canUseTreeRootResolverKey(key: string): boolean {
  const scope = driveRootScopeFromResolverKey(key);
  return !scope || hasActiveDriveRootScope(scope.rootScopeId);
}

function syncDriveRootAuthorization(
  key: string,
  rootScopeId: string,
  driveId: string,
): { authorization: DriveRootAuthorization; changed: boolean; projectionChanged: boolean } {
  const state = projectionState(key);
  const authorization = driveRootAuthorization(rootScopeId);
  const previousFingerprint = state.authorizationFingerprint;
  const changed = shouldResetDriveRootProjection(
    previousFingerprint,
    authorization.fingerprint,
  );
  state.authorizationFingerprint = authorization.fingerprint;
  const projectionChanged = profileDriveProjection.pruneUnauthorized(
    rootScopeId,
    driveId,
    authorization.appKeys,
  );

  if (!authorization.active || changed) {
    // A registry snapshot has no author provenance. It must be re-proven on
    // the first authorization fingerprint after reload as well as after a
    // later identity/roster change.
    if (treeRootRegistry.get(rootScopeId, driveId)) {
      treeRootRegistry.delete(rootScopeId, driveId);
    }
    const entry = subscriptionState.get(key);
    if (entry) {
      entry.decryptedKey = undefined;
      if (changed && previousFingerprint !== undefined) {
        entry.listeners.forEach((listener) => listener(
          null,
          undefined,
          { visibility: 'private' },
          { updatedAt: Math.floor(Date.now() / 1000) },
        ));
      }
    }
  }

  return { authorization, changed, projectionChanged };
}

function applyDriveRootEvent(
  key: string,
  rootScopeId: string,
  driveId: string,
  event: NostrToolsEvent,
  options: { rebuild?: boolean } = {},
): boolean {
  const secretKey = getSecretKey();
  if (!secretKey) return false;

  const { authorization, changed, projectionChanged } = syncDriveRootAuthorization(
    key,
    rootScopeId,
    driveId,
  );
  if (!authorization.active) return false;
  if (!authorization.appKeys.has(event.pubkey)) {
    console.warn('[treeRoot] Ignoring Drive root from unauthorized AppKey');
    if (options.rebuild !== false && (changed || projectionChanged)) {
      scheduleDriveRootProjection(key, rootScopeId, driveId);
    }
    return false;
  }

  let parsed;
  try {
    parsed = parseDriveRootEventForDevice(event, secretKey);
  } catch (error) {
    console.warn('[treeRoot] Ignoring unreadable NostrIdentity drive root:', error);
    return false;
  }

  if (parsed.root_scope_id !== rootScopeId || parsed.drive_id !== driveId) return false;

  const accepted = profileDriveProjection.add(event, parsed);
  if ((accepted || changed || projectionChanged) && options.rebuild !== false) {
    scheduleDriveRootProjection(key, rootScopeId, driveId);
  }
  return accepted;
}

function scheduleDriveRootProjection(key: string, rootScopeId: string, driveId: string): void {
  enqueueDriveRootProjection(key, rootScopeId, driveId);
}

function requestDriveRootProjection(
  key: string,
  rootScopeId: string,
  driveId: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    enqueueDriveRootProjection(key, rootScopeId, driveId, { resolve, reject });
  });
}

function enqueueDriveRootProjection(
  key: string,
  rootScopeId: string,
  driveId: string,
  waiter?: ProjectionRebuildWaiter,
): void {
  const state = projectionState(key);
  state.requested += 1;
  if (waiter) state.waiters.push(waiter);
  if (state.running) return;
  state.running = true;
  queueMicrotask(() => {
    void rebuildDriveRootProjection(key, rootScopeId, driveId, state);
  });
}

async function rebuildDriveRootProjection(
  key: string,
  rootScopeId: string,
  driveId: string,
  state: ProjectionRebuildState,
): Promise<void> {
  let applied = false;
  let failure: unknown;
  try {
    while (state.requested > 0) {
      state.requested = 0;
      const { authorization } = syncDriveRootAuthorization(key, rootScopeId, driveId);
      if (!authorization.active || authorization.appKeys.size === 0) {
        state.retryPending = false;
        continue;
      }
      const authorizationFingerprint = authorization.fingerprint;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DRIVE_ROOT_MATERIALIZE_TIMEOUT_MS);
      let materialized;
      try {
        materialized = await profileDriveProjection.materialize(
          getTree(),
          rootScopeId,
          driveId,
          authorization.appKeys,
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
      if (!materialized || state.requested > 0) continue;

      const currentAuthorization = syncDriveRootAuthorization(key, rootScopeId, driveId).authorization;
      if (!currentAuthorization.active || currentAuthorization.fingerprint !== authorizationFingerprint) {
        state.requested += 1;
        continue;
      }

      const entry = subscriptionState.get(key);
      const visibilityInfo: SubscribeVisibilityInfo = { visibility: 'private' };
      const apply = () => treeRootRegistry.setFromResolver(
        rootScopeId,
        driveId,
        materialized.root.hash,
        materialized.updatedAt,
        {
          key: materialized.root.key,
          visibility: 'private',
          labels: ['iris-drive'],
        },
      );
      let updated = apply();
      if (!updated && treeRootRegistry.getByKey(key)?.dirty) {
        await treeRootRegistry.flushPendingPublishes();
        updated = apply();
      }
      const record = treeRootRegistry.getByKey(key);
      const recordMatches = !!record
        && toHex(record.hash) === toHex(materialized.root.hash)
        && (!materialized.root.key || (!!record.key && toHex(record.key) === toHex(materialized.root.key)));
      if (!updated && !recordMatches) {
        throw new Error('Could not apply the current NostrIdentity Drive projection');
      }

      if (entry) {
        entry.decryptedKey = materialized.root.key;
        entry.listeners.forEach(listener => listener(
          materialized.root.hash,
          materialized.root.key,
          visibilityInfo,
          { updatedAt: materialized.updatedAt },
        ));
      }
      state.retryPending = false;
      applied = true;
    }
  } catch (error) {
    state.retryPending = true;
    failure = error;
    console.warn('[treeRoot] Failed to materialize NostrIdentity Drive roots:', error);
  } finally {
    state.running = false;
    const waiters = state.waiters.splice(0);
    for (const waiter of waiters) {
      if (failure) waiter.reject(failure);
      else waiter.resolve(applied);
    }
    if (state.requested > 0) {
      state.running = true;
      queueMicrotask(() => {
        void rebuildDriveRootProjection(key, rootScopeId, driveId, state);
      });
    }
  }
}

function rawSignedEvent(event: Event): NostrToolsEvent | null {
  const rawEvent = event as Partial<NostrToolsEvent>;
  if (!rawEvent.id || !rawEvent.sig || !rawEvent.pubkey || !rawEvent.tags || typeof rawEvent.kind !== 'number') {
    return null;
  }
  return rawEvent as NostrToolsEvent;
}

async function backfillDriveRootScope(
  key: string,
  rootScopeId: string,
  driveId: string,
  options: { forceRebuild?: boolean; awaitRebuild?: boolean } = {},
): Promise<boolean> {
  const initial = syncDriveRootAuthorization(key, rootScopeId, driveId);
  if (!initial.authorization.active) return false;

  const filters = driveRootBackfillFilters(
    rootScopeId,
    driveId,
    initial.authorization.appKeys,
  );
  const events = filters.length > 0 ? await nostr.fetchEvents(filters) : new Set<Event>();
  let accepted = false;
  for (const event of events) {
    const rawEvent = rawSignedEvent(event);
    if (rawEvent) {
      accepted = applyDriveRootEvent(key, rootScopeId, driveId, rawEvent, { rebuild: false }) || accepted;
    }
  }

  const current = syncDriveRootAuthorization(key, rootScopeId, driveId);
  if (!current.authorization.active) return false;
  const rebuildState = projectionState(key);
  const shouldRetry = rebuildState.retryPending
    && profileDriveProjection.hasAuthorizedRoots(
      rootScopeId,
      driveId,
      current.authorization.appKeys,
    );
  const shouldRebuild = options.forceRebuild
    || accepted
    || initial.changed
    || initial.projectionChanged
    || current.changed
    || current.projectionChanged
    || shouldRetry;
  if (!shouldRebuild) return false;
  if (options.awaitRebuild) {
    return requestDriveRootProjection(key, rootScopeId, driveId);
  }
  scheduleDriveRootProjection(key, rootScopeId, driveId);
  return true;
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
  if (!hasActiveDriveRootScope(scope.rootScopeId)) {
    syncDriveRootAuthorization(key, scope.rootScopeId, scope.driveId);
    return;
  }
  const state = subscriptionState.get(key);
  if (state && !state.unsubscribeResolver && !state.unsubscribeWorker) {
    void startResolverSubscription(key);
    return;
  }
  void backfillDriveRootScope(key, scope.rootScopeId, scope.driveId)
    .catch((error) => {
      console.warn('[treeRoot] Failed to backfill NostrIdentity drive roots:', error);
    });
}

/**
 * Rebuild the logical Drive view after a local publisher has already retained
 * its signed event in the projection. The later relay echo is intentionally
 * deduplicated, so it cannot be relied on to schedule this rebuild.
 */
export function rebuildRetainedDriveRootProjection(key: string): boolean {
  const scope = driveRootScopeFromResolverKey(key);
  if (!scope) return false;
  const { authorization } = syncDriveRootAuthorization(
    key,
    scope.rootScopeId,
    scope.driveId,
  );
  if (!authorization.active || !profileDriveProjection.hasAuthorizedRoots(
    scope.rootScopeId,
    scope.driveId,
    authorization.appKeys,
  )) return false;
  scheduleDriveRootProjection(key, scope.rootScopeId, scope.driveId);
  return true;
}

type ResolveDriveRootProjectionOptions = {
  publishWaitTimeoutMs?: number;
  publishWaitPollIntervalMs?: number;
};

async function waitForNewestLocalDriveRootPublish(
  rootScopeId: string,
  driveId: string,
  options: ResolveDriveRootProjectionOptions,
): Promise<boolean> {
  // Flush a publish that is still waiting on the registry throttle. If its
  // timer already fired, the registry no longer retains the in-flight promise,
  // so passively wait for that exact production path to mark the record clean.
  // Do not call flush repeatedly: that can duplicate retries for a slow root.
  await treeRootRegistry.flushPendingPublishes();

  const configuredTimeout = options.publishWaitTimeoutMs
    ?? DRIVE_ROOT_LOCAL_PUBLISH_WAIT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(0, configuredTimeout)
    : DRIVE_ROOT_LOCAL_PUBLISH_WAIT_TIMEOUT_MS;
  const configuredInterval = options.publishWaitPollIntervalMs
    ?? DRIVE_ROOT_LOCAL_PUBLISH_POLL_INTERVAL_MS;
  const pollIntervalMs = Number.isFinite(configuredInterval)
    ? Math.max(1, configuredInterval)
    : DRIVE_ROOT_LOCAL_PUBLISH_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const current = treeRootRegistry.get(rootScopeId, driveId);
    if (!current) return false;
    if (current.source !== 'local-write' || !current.dirty) return true;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, remaining));
    });
  }
}

/**
 * Force the current logical Drive view to be rebuilt from every authorized
 * AppKey root. Unlike the UI refresh helper, this is awaitable and never treats
 * an existing registry record as proof that the projection is current.
 */
export async function resolveDriveRootProjectionNow(
  key: string,
  options: ResolveDriveRootProjectionOptions = {},
): Promise<boolean> {
  const scope = driveRootScopeFromResolverKey(key);
  if (!scope) throw new Error('Drive projection key must use a NostrIdentity profile UUID');
  if (!hasActiveDriveRootScope(scope.rootScopeId)) {
    syncDriveRootAuthorization(key, scope.rootScopeId, scope.driveId);
    throw new Error('Drive projection requires an active matching NostrIdentity session');
  }
  const existing = treeRootRegistry.get(scope.rootScopeId, scope.driveId);
  const hadDirtyLocalWrite = existing?.source === 'local-write' && existing.dirty;
  if (hadDirtyLocalWrite) {
    if (!await waitForNewestLocalDriveRootPublish(
      scope.rootScopeId,
      scope.driveId,
      options,
    )) {
      throw new Error('Could not publish the newest local Drive root before rebuilding');
    }
  }

  const currentLocal = treeRootRegistry.get(scope.rootScopeId, scope.driveId);
  if (currentLocal?.source === 'local-write' && !hadDirtyLocalWrite) {
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../drive/profileDriveRootPublish');
    const retained = await publishNostrIdentityDriveRootIfAvailable(scope.driveId, {
      hash: currentLocal.hash,
      key: currentLocal.key,
    });
    if (!retained) {
      throw new Error('Could not retain the newest local Drive root before rebuilding');
    }
  }
  // The caller explicitly requested a fresh logical projection. A hydrated
  // record can predate the current roster and its timestamp would otherwise
  // prevent an older-but-authoritative rebuilt view from replacing it.
  treeRootRegistry.delete(scope.rootScopeId, scope.driveId);
  return backfillDriveRootScope(key, scope.rootScopeId, scope.driveId, {
    forceRebuild: true,
    awaitRebuild: true,
  });
}

function subscribeToDriveRootScope(key: string, rootScopeId: string, driveId: string): () => void {
  const filter: Filter = {
    kinds: [KIND_DRIVE_ROOT],
    '#d': [driveRootDTag(rootScopeId, driveId)],
  };
  const opts = {
    closeAfterHistory: false,

  };

  const attachSub = () => {
    const sub = nostr.subscribe(filter, opts);
    sub.on('event', (event: Event) => {
      const rawEvent = rawSignedEvent(event);
      if (rawEvent) void applyDriveRootEvent(key, rootScopeId, driveId, rawEvent);
    });
    return sub;
  };

  let sub = attachSub();
  const fetchSnapshot = () => {
    void backfillDriveRootScope(key, rootScopeId, driveId)
      .catch((error) => {
        console.warn('[treeRoot] Failed to backfill NostrIdentity drive roots:', error);
      });
  };
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
 * This is called asynchronously after the worker event backend is ready
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
    if (!hasActiveDriveRootScope(npub)) {
      syncDriveRootAuthorization(key, npub, treeName);
      return;
    }
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
  const driveScope = driveRootScopeFromResolverKey(key);
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
  state.listeners.add(callback);

  if (driveScope && !hasActiveDriveRootScope(driveScope.rootScopeId)) {
    syncDriveRootAuthorization(key, driveScope.rootScopeId, driveScope.driveId);
    return () => {
      subscriptionState.get(key)?.listeners.delete(callback);
    };
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

  // Emit current snapshot from registry if available
  const record = treeRootRegistry.getByKey(key);
  if (record && canUseTreeRootResolverKey(key)) {
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
