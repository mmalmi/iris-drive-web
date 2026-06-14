import type { Hash, TreeVisibility } from '@hashtree/core';
import { npubToPubkey } from '../nostr/trees';
import { logHtreeDebug } from '../lib/htreeDebug';
import { treeRootRegistry, type TreeRootRecord } from '../TreeRootRegistry';
import {
  getWorkerRootSignature,
  subscriptionState,
  workerRootCacheSync,
} from './treeRootShared';

// Wait for worker to be ready before creating subscriptions
// This ensures the NDK transport plugin is registered
let workerReadyPromise: Promise<void> | null = null;
let workerReadyResolve: (() => void) | null = null;
export const WORKER_READY_TIMEOUT_MS = 10000;

/**
 * Signal that the worker is ready (called from auth.ts after initHashtreeWorker)
 */
export function signalWorkerReady(): void {
  if (workerReadyResolve) {
    workerReadyResolve();
    workerReadyResolve = null;
  }
  logHtreeDebug('worker:ready');
}

/**
 * Wait for the worker to be ready
 */
export function waitForWorkerReady(): Promise<void> {
  if (!workerReadyPromise) {
    workerReadyPromise = new Promise((resolve) => {
      // Check if worker is already ready (import dynamically to avoid circular deps)
      import('../lib/workerInit').then(({ isWorkerReady }) => {
        if (isWorkerReady()) {
          resolve();
        } else {
          workerReadyResolve = resolve;
        }
      });
    });
  }
  return workerReadyPromise;
}


export async function syncResolvedTreeRootToWorker(key: string, record: TreeRootRecord): Promise<void> {
  if (record.source !== 'nostr' && record.source !== 'prefetch') return;

  const signature = getWorkerRootSignature(record);
  if (workerRootCacheSync.get(key) === signature) return;

  const slashIndex = key.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= key.length - 1) return;

  const npub = key.slice(0, slashIndex);
  const treeName = key.slice(slashIndex + 1);

  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('setTreeRootCache' in adapter)) return;

    await (adapter as {
      setTreeRootCache: (
        npub: string,
        treeName: string,
        hash: Hash,
        key?: Hash,
        visibility?: TreeVisibility,
        labels?: string[],
        metadata?: {
          encryptedKey?: string;
          keyId?: string;
          selfEncryptedKey?: string;
          selfEncryptedLinkKey?: string;
        }
      ) => Promise<void>;
    }).setTreeRootCache(npub, treeName, record.hash, record.key, record.visibility, record.labels, {
      encryptedKey: record.encryptedKey,
      keyId: record.keyId,
      selfEncryptedKey: record.selfEncryptedKey,
      selfEncryptedLinkKey: record.selfEncryptedLinkKey,
    });

    workerRootCacheSync.set(key, signature);
  } catch (err) {
    console.warn('[treeRoot] Failed to sync resolved tree root to worker:', err);
  }
}

export async function mergeTreeRootKeyToWorker(
  npub: string,
  treeName: string,
  hash: Hash,
  key: Hash
): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
    if (!adapter || !('mergeTreeRootKey' in adapter)) return false;
    return await adapter.mergeTreeRootKey(npub, treeName, hash, key);
  } catch (err) {
    console.warn('[treeRoot] Failed to merge tree root key in worker:', err);
    return false;
  }
}

export async function ensureWorkerTreeRootSubscription(npub: string): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('subscribeTreeRoots' in adapter)) return false;

    const pubkey = npubToPubkey(npub) ?? npub;
    await adapter.subscribeTreeRoots(pubkey);
    return true;
  } catch (err) {
    console.warn('[treeRoot] Failed to subscribe worker to tree roots:', err);
    return false;
  }
}

export async function unsubscribeWorkerTreeRootSubscription(npub: string): Promise<void> {
  try {
    const { getWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter();
    if (!adapter || !('unsubscribeTreeRoots' in adapter)) return;

    const pubkey = npubToPubkey(npub) ?? npub;
    await adapter.unsubscribeTreeRoots(pubkey);
  } catch (err) {
    console.warn('[treeRoot] Failed to unsubscribe worker from tree roots:', err);
  }
}

export async function hydrateTreeRootFromWorker(npub: string, treeName: string): Promise<boolean> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(2000);
    if (!adapter || !('getTreeRootInfo' in adapter)) return false;

    const record = await adapter.getTreeRootInfo(npub, treeName);
    if (!record) return false;

    treeRootRegistry.setFromWorker(npub, treeName, record.hash, record.updatedAt, {
      key: record.key,
      visibility: record.visibility,
      labels: record.labels,
      encryptedKey: record.encryptedKey,
      keyId: record.keyId,
      selfEncryptedKey: record.selfEncryptedKey,
      selfEncryptedLinkKey: record.selfEncryptedLinkKey,
    });
    return true;
  } catch (err) {
    console.warn('[treeRoot] Failed to hydrate tree root from worker:', err);
    return false;
  }
}

const WORKER_HYDRATE_RETRY_DELAYS_MS = [250, 1000, 2500, 5000];

export function clearWorkerHydrateRetry(key: string): void {
  const state = subscriptionState.get(key);
  if (!state?.workerHydrateRetryTimer) return;
  clearTimeout(state.workerHydrateRetryTimer);
  state.workerHydrateRetryTimer = null;
}

export function scheduleWorkerHydrateRetry(
  key: string,
  npub: string,
  treeName: string,
  options?: { skipWorkerHydrate?: boolean },
  attempt: number = 0
): void {
  if (options?.skipWorkerHydrate) return;
  const delay = WORKER_HYDRATE_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;

  const state = subscriptionState.get(key);
  if (!state) return;
  clearWorkerHydrateRetry(key);

  state.workerHydrateRetryTimer = setTimeout(() => {
    const active = subscriptionState.get(key);
    if (!active) return;

    active.workerHydrateRetryTimer = null;

    void hydrateTreeRootFromWorker(npub, treeName).then((hydrated) => {
      if (hydrated) {
        logHtreeDebug('treeRoot:hydrate-retry', { resolverKey: key, attempt: attempt + 1 });
        return;
      }
      scheduleWorkerHydrateRetry(key, npub, treeName, options, attempt + 1);
    });
  }, delay);
}
