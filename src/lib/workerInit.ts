import { localIndexSource, verifyNostrEvent } from 'nostr-pubsub';
/**
 * Backend Initialization
 *
 * Initializes either the browser worker runtime or the native Rust-backed
 * backend, depending on the current host environment.
 */

import {
  initWorkerAdapter,
  getWorkerAdapter as getSharedBackendAdapter,
  setWorkerAdapterInstance,
  type BackendAdapter,
} from '../workerAdapter';
import { initNativeBackend } from '../nativeAdapter';
import {
  settingsStore,
  waitForSettingsLoaded,
} from '../stores/settings';
import { refreshFipsStats, setBlossomBandwidth } from '../store';
import { get } from 'svelte/store';
import { setupVersionCallback } from '../utils/socialGraph';
import { nostr } from '../nostr/client';
import { initRelayTracking } from '../nostr/relays';
import { getAppType } from '../appType';
import { logHtreeDebug } from './htreeDebug';
import { getRuntimeEndpoints, getRuntimeHtreeServerUrl } from './htreeRuntime';
import { getEffectiveBlossomServers, getEffectiveNostrRelays } from './runtimeNetwork';
import { setupTreeRootRegistryBridge } from './workerTreeRootBridge';
import { initializePublishFn } from '../treeRootCache';
import { setupMediaStreaming } from './mediaStreamingSetup';
import type { WorkerNostrFilter } from '@hashtree/core';
import {
  attachDriveFipsProvider,
  startDriveFipsRuntime,
  stopDriveFipsRuntime,
} from './driveFipsRuntime';
import {
  createDriveFipsRosterAuthorizationSource,
  resolveDriveFipsIdentity,
  type ResolvedDriveFipsIdentity,
} from './driveFipsIdentity';
import { accountsStore } from '../accounts';

const isTestMode = !!import.meta.env.VITE_TEST_MODE;

/**
 * Get the active backend adapter
 */
export function getWorkerAdapter(): BackendAdapter | null {
  return getSharedBackendAdapter();
}

if (typeof window !== 'undefined') {
  (window as typeof window & { __getWorkerAdapter?: () => BackendAdapter | null }).__getWorkerAdapter = getWorkerAdapter;
}

export async function waitForWorkerAdapter(maxWaitMs = 5000): Promise<BackendAdapter | null> {
  const start = Date.now();
  let adapter = getWorkerAdapter();
  while (!adapter && Date.now() - start < maxWaitMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
    adapter = getWorkerAdapter();
  }
  return adapter;
}

let initialized = false;
let initPromise: Promise<void> | null = null;
let lastBlossomServersHash = '';
let lastRelaysHash = '';
let fipsStoreName: string | null = null;
let fipsIdentity: ResolvedDriveFipsIdentity | null = null;
let fipsRuntimeReadyFor: BackendAdapter | null = null;
let fipsDesiredKey = '';
let fipsActiveKey = '';
let fipsSyncVersion = 0;
let fipsSyncTail: Promise<void> = Promise.resolve();
let fipsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let fipsRetryDelayMs = 1_000;

function clearFipsRetry(): void {
  if (fipsRetryTimer) clearTimeout(fipsRetryTimer);
  fipsRetryTimer = null;
}

function startFipsForAdapter(
  adapter: BackendAdapter,
  relays: string[],
  storeName: string,
  identity: ResolvedDriveFipsIdentity | null,
  retry = false,
): Promise<void> {
  const desiredKey = JSON.stringify({
    relays,
    storeName,
    appKeyPubkey: identity?.appKeyPubkey ?? null,
    profileId: identity?.profileId ?? null,
  });
  if (desiredKey === fipsDesiredKey) return fipsSyncTail;
  clearFipsRetry();
  if (!retry) fipsRetryDelayMs = 1_000;
  fipsDesiredKey = desiredKey;
  const version = ++fipsSyncVersion;
  const sync = fipsSyncTail.catch(() => undefined).then(async () => {
    if (version !== fipsSyncVersion || getWorkerAdapter() !== adapter) return;
    if (desiredKey === fipsActiveKey && fipsRuntimeReadyFor === adapter) return;

    fipsRuntimeReadyFor = null;
    adapter.setP2PProvider?.(null);
    await adapter.setNostrSource?.(null);
    await stopDriveFipsRuntime();
    if (version !== fipsSyncVersion || getWorkerAdapter() !== adapter) return;
    if (!identity) {
      fipsActiveKey = desiredKey;
      return;
    }

    try {
      const authorizedAppKeyPubkeys = await driveFipsAuthorizedAppKeySource(identity);
      const runtime = await startDriveFipsRuntime({
        relays,
        storeName,
        deviceSecretKey: identity.deviceSecretKey,
        profileId: identity.profileId,
        authorizedAppKeyPubkeys,
        retainedEventReader: {
          query: async (filters, options) => {
            const report = await adapter.queryEvents?.(filters, { ...options, cache: 'cache-only', relays: [], sources: [] });
            return { complete: report?.complete ?? false, events: (report?.events ?? []).map(event => ({
              event: verifyNostrEvent(event), source: localIndexSource('drive-cache'), priority: 0,
            })) };
          },
        },
        log: isTestMode,
      });
      if (version !== fipsSyncVersion || getWorkerAdapter() !== adapter) {
        await runtime.stop();
        return;
      }
      attachDriveFipsProvider(adapter, runtime);
      await adapter.setNostrSource?.(runtime.getNostrSource());
      fipsActiveKey = desiredKey;
      fipsRuntimeReadyFor = adapter;
      fipsRetryDelayMs = 1_000;
      console.log('[WorkerInit] FIPS runtime ready');
    } catch (error) {
      if (version !== fipsSyncVersion) return;
      adapter.setP2PProvider?.(null);
      await adapter.setNostrSource?.(null);
      await stopDriveFipsRuntime().catch(() => undefined);
      fipsDesiredKey = '';
      console.warn('[WorkerInit] FIPS runtime failed to start:', error);
      const delay = fipsRetryDelayMs;
      fipsRetryDelayMs = Math.min(delay * 2, 30_000);
      fipsRetryTimer = setTimeout(() => {
        fipsRetryTimer = null;
        if (getWorkerAdapter() === adapter && fipsStoreName === storeName) {
          void startFipsForAdapter(adapter, relays, storeName, identity, true);
        }
      }, delay);
    }
  });
  fipsSyncTail = sync;
  return sync;
}

async function driveFipsAuthorizedAppKeySource(
  identity: ResolvedDriveFipsIdentity,
): Promise<() => Promise<string[]>> {
  const profileId = identity.profileId;
  if (!profileId) return async () => [identity.appKeyPubkey];
  const {
    getCurrentNostrIdentitySession,
    refreshCurrentDriveRosterOps,
  } = await import('../nostr/auth');
  return createDriveFipsRosterAuthorizationSource({
    identity: { ...identity, profileId },
    getSession: getCurrentNostrIdentitySession,
    refreshRosterOps: refreshCurrentDriveRosterOps,
    onRefreshError: (error) => {
      console.warn('[WorkerInit] Failed to refresh FIPS AppKey authorization:', error);
    },
  });
}

function resolveFipsIdentityForBackend(identity: WorkerInitIdentity): ResolvedDriveFipsIdentity | null {
  const account = accountsStore.getState().accounts.find(({ pubkey }) => pubkey === identity.pubkey);
  return resolveDriveFipsIdentity({
    pubkey: identity.pubkey,
    nsec: identity.nsec,
    profileId: account?.nostrIdentityId,
  });
}

/**
 * Sync blossom server settings from settings store to worker.
 * Uses a hash to avoid duplicate updates.
 */
function syncBlossomServers(): void {
  const adapter = getWorkerAdapter();
  if (!adapter) return;

  const settings = get(settingsStore);
  const blossomServers = getEffectiveBlossomServers(settings.network.blossomServers);

  // Hash to avoid duplicate updates
  const serversHash = JSON.stringify(blossomServers);
  if (serversHash === lastBlossomServersHash) return;
  lastBlossomServersHash = serversHash;

  console.log('[WorkerInit] Syncing blossom servers to worker:', blossomServers.length, 'servers');
  adapter.setBlossomServers(blossomServers);
}

/**
 * Sync relay settings from settings store to worker.
 * Uses a hash to avoid duplicate updates.
 */
function syncRelays(): void {
  const adapter = getWorkerAdapter();
  if (!adapter) return;

  if (!('setRelays' in adapter)) return;

  const settings = get(settingsStore);
  const relays = getEffectiveNostrRelays(settings.network.relays);

  // Hash to avoid duplicate updates
  const relaysHash = JSON.stringify(relays);
  if (relaysHash === lastRelaysHash) return;
  lastRelaysHash = relaysHash;

  console.log('[WorkerInit] Syncing relays to worker:', relays.length, 'relays');
  (adapter as { setRelays: (relays: string[]) => void }).setRelays(relays);
  if (fipsStoreName) {
    void startFipsForAdapter(adapter, relays, fipsStoreName, fipsIdentity);
  }
}

let lastStorageMaxBytesHash = '';

/**
 * Sync storage limit from settings store to worker.
 * Uses a hash to avoid duplicate updates.
 */
function syncStorageSettings(): void {
  const adapter = getWorkerAdapter();
  if (!adapter) return;

  const settings = get(settingsStore);
  const maxBytes = settings.storage.maxBytes;

  // Hash to avoid duplicate updates
  const storageHash = String(maxBytes);
  if (storageHash === lastStorageMaxBytesHash) return;
  lastStorageMaxBytesHash = storageHash;

  console.log('[WorkerInit] Syncing storage limit to worker:', Math.round(maxBytes / 1024 / 1024), 'MB');
  adapter.setStorageMaxBytes(maxBytes);
}

export interface WorkerInitIdentity {
  pubkey: string;
  nsec?: string;  // hex-encoded secret key (only for nsec login)
}

function shouldUseNativeBackend(): boolean {
  return !!getRuntimeHtreeServerUrl();
}

/**
 * Wait for service worker to be ready (needed for COOP/COEP headers)
 */
async function waitForServiceWorker(maxWaitMs?: number): Promise<boolean> {
  if (shouldUseNativeBackend()) return true;
  if (!('serviceWorker' in navigator)) return true;

  try {
    if (navigator.serviceWorker.controller) {
      return true;
    }

    const readyPromise = navigator.serviceWorker.ready.then(() => true);
    if (maxWaitMs === undefined) {
      return await readyPromise;
    }

    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), maxWaitMs);
    });

    return await Promise.race([readyPromise, timeoutPromise]);
  } catch {
    return false;
  }
}

/**
 * Initialize the active hashtree backend with user identity.
 * Safe to call multiple times - only initializes once.
 */
export async function initHashtreeBackend(identity: WorkerInitIdentity): Promise<void> {
  if (initialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    const t0 = performance.now();
    const logT = (msg: string) => console.log(`[initHashtreeBackend] ${msg}: ${Math.round(performance.now() - t0)}ms`);
    const backendMode = shouldUseNativeBackend() ? 'native' : 'worker';
    logHtreeDebug('worker:init:start', {
      appType: getAppType(),
      backend: backendMode,
    });

    try {
      // Wait for service worker to be ready before loading workers
      const serviceWorkerPromise = waitForServiceWorker(500).then((ready) => {
        logT(ready ? 'waitForServiceWorker done' : 'waitForServiceWorker timed out');
      });

      // Load settings before worker init so relays/blossom match persisted config.
      const settingsReady = waitForSettingsLoaded().then(() => {
        logT('waitForSettingsLoaded done');
        return true;
      });
      const settingsPromise = isTestMode
        ? settingsReady
        : Promise.race([
            settingsReady,
            new Promise<boolean>((resolve) => {
              setTimeout(() => {
                logT('waitForSettingsLoaded timed out');
                resolve(false);
              }, 500);
            }),
          ]);

      await Promise.all([serviceWorkerPromise, settingsPromise]);

      const settings = get(settingsStore);
      const runtimeEndpoints = getRuntimeEndpoints({
        relays: settings.network.relays,
        blossomServers: settings.network.blossomServers,
      });

      const config = {
        storeName: 'hashtree-worker',
        relays: runtimeEndpoints.nostrRelays,
        blossomServers: runtimeEndpoints.blossomServers,
        pubkey: identity.pubkey,
        nsec: identity.nsec,
      };

      let adapter: BackendAdapter | null = null;
      if (backendMode === 'native') {
        logT('Starting native backend');
        adapter = await initNativeBackend(config);
        setWorkerAdapterInstance(adapter);
        logT('Native backend ready');
      } else {
        const { default: HashtreeWorker } = await import('../workers/hashtree.worker?worker');
        logT('Starting web worker');
        adapter = await initWorkerAdapter(HashtreeWorker, config);
        logT('Web worker ready');
      }
      logHtreeDebug('worker:init:ready', { backend: backendMode });

      initialized = true;
      logHtreeDebug('worker:init:done', { backend: backendMode });

      // Hook shared backend callbacks and runtime bridges
      adapter = getWorkerAdapter();
      if (adapter) {
        adapter.onBlossomBandwidth((stats) => {
          setBlossomBandwidth(stats);
        });

        if (backendMode === 'worker') {
          fipsStoreName = config.storeName;
          fipsIdentity = resolveFipsIdentityForBackend(identity);
          adapter.onIdentityChange?.((nextIdentity) => {
            fipsIdentity = resolveFipsIdentityForBackend(nextIdentity);
            if (fipsStoreName) {
              const settings = get(settingsStore);
              const relays = getEffectiveNostrRelays(settings.network.relays);
              void startFipsForAdapter(adapter, relays, fipsStoreName, fipsIdentity);
            }
          });
          startFipsForAdapter(
            adapter,
            runtimeEndpoints.nostrRelays,
            config.storeName,
            fipsIdentity,
          );

        }
        nostr.setBackend({
          subscribe: (filters, onEvent, onHistory) => adapter!.subscribe(filters as WorkerNostrFilter[], onEvent, onHistory),
          unsubscribe: id => adapter!.unsubscribe(id),
          publish: event => adapter!.publish(event),
        });

        // Signal that the backend is ready for tree root subscriptions
        import('../stores/treeRoot').then(({ signalWorkerReady }) => {
          signalWorkerReady();
        });

        // Start connectivity polling ASAP after worker is ready.
        refreshFipsStats();
        setInterval(refreshFipsStats, 2000);
        initRelayTracking();
      }

      // Set up social graph version callback
      setupVersionCallback();

      // Subscribe to settings changes to keep worker in sync
      settingsStore.subscribe(() => {
        if (initialized) {
          syncBlossomServers();
          syncRelays();
          syncStorageSettings();
        }
      });

      // Initial sync of all settings to worker
      syncBlossomServers();
      syncRelays();
      syncStorageSettings();

      // Set up tree root registry bridge to sync cache to worker
      setupTreeRootRegistryBridge(getWorkerAdapter);

      // Initialize the publish function now that all dependencies are ready
      await initializePublishFn();

      // Set up direct SW <-> Worker communication for file streaming
      setupMediaStreaming().catch(err => {
        console.warn('[WorkerInit] Media streaming setup failed:', err);
      });
    } catch (err) {
      console.error('[WorkerInit] Failed to initialize backend:', err);
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Check if the worker is initialized and ready.
 */
export function isWorkerReady(): boolean {
  return initialized && getWorkerAdapter() !== null;
}

export function isFipsRuntimeReady(): boolean {
  const adapter = getWorkerAdapter();
  return adapter !== null && fipsRuntimeReadyFor === adapter;
}

/**
 * Wait for at least one relay to be connected.
 * Returns immediately if worker is not ready or times out after maxWait ms.
 */
export async function waitForRelayConnection(maxWait = 5000): Promise<boolean> {
  const adapter = getWorkerAdapter();
  if (!adapter) return false;

  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < maxWait) {
    try {
      const stats = await adapter.getRelayStats();
      const connected = stats.filter(r => r.connected).length;
      if (connected > 0) {
        return true;
      }
    } catch {
      // Ignore errors, keep polling
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return false;
}

export async function initHashtreeWorker(identity: WorkerInitIdentity): Promise<void> {
  return initHashtreeBackend(identity);
}

export async function stopHashtreeBrowserP2P(): Promise<void> {
  fipsSyncVersion += 1;
  clearFipsRetry();
  fipsRetryDelayMs = 1_000;
  fipsStoreName = null;
  fipsIdentity = null;
  fipsDesiredKey = '';
  fipsActiveKey = '';
  fipsRuntimeReadyFor = null;
  getWorkerAdapter()?.setP2PProvider?.(null);
  await fipsSyncTail.catch(() => undefined);
  await stopDriveFipsRuntime();
}
