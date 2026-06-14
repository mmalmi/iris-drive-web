import { writable, get, type Readable } from 'svelte/store';
import { toHex, type CID } from '@hashtree/core';
import { routeStore, getRouteSync } from './route';
import type { RouteInfo } from '../utils/route';
import {
  readTreeEventSnapshot,
  resolveSnapshotRootCid,
  type TreeEventSnapshotInfo,
} from '../lib/treeEventSnapshots';

export interface PermalinkSnapshotState {
  active: boolean;
  loading: boolean;
  snapshot: TreeEventSnapshotInfo | null;
  rootCid: CID | null;
  error: string | null;
}

const initialState: PermalinkSnapshotState = {
  active: false,
  loading: false,
  snapshot: null,
  rootCid: null,
  error: null,
};

function isSnapshotPermalinkRoute(route: RouteInfo): boolean {
  return route.isPermalink && route.params.get('snapshot') === '1' && !!route.cid;
}

const permalinkSnapshotWritable = writable<PermalinkSnapshotState>(initialState);
let requestToken = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempts = 0;
let lastRouteKey: string | null = null;
const SNAPSHOT_RETRY_DELAY_MS = 1500;
const SNAPSHOT_MAX_RETRIES = 24;

function getSnapshotRouteKey(route: RouteInfo): string | null {
  if (!isSnapshotPermalinkRoute(route) || !route.cid?.hash) return null;
  return `${toHex(route.cid.hash)}:${route.params.get('k') ?? ''}`;
}

function clearRetryTimer(): void {
  if (!retryTimer) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(route: RouteInfo): void {
  if (retryTimer || retryAttempts >= SNAPSHOT_MAX_RETRIES) return;
  retryAttempts += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void updatePermalinkSnapshot(route);
  }, SNAPSHOT_RETRY_DELAY_MS);
}

async function updatePermalinkSnapshot(route: RouteInfo): Promise<void> {
  const token = ++requestToken;
  const routeKey = getSnapshotRouteKey(route);

  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    retryAttempts = 0;
    clearRetryTimer();
  }

  if (!isSnapshotPermalinkRoute(route) || !route.cid) {
    clearRetryTimer();
    permalinkSnapshotWritable.set(initialState);
    return;
  }

  permalinkSnapshotWritable.set({
    active: true,
    loading: true,
    snapshot: null,
    rootCid: null,
    error: null,
  });

  const snapshot = await readTreeEventSnapshot(route.cid);
  if (token !== requestToken) {
    return;
  }
  if (!snapshot) {
    if (retryAttempts < SNAPSHOT_MAX_RETRIES) {
      scheduleRetry(route);
      permalinkSnapshotWritable.set({
        active: true,
        loading: true,
        snapshot: null,
        rootCid: null,
        error: null,
      });
      return;
    }
    clearRetryTimer();
    permalinkSnapshotWritable.set({
      active: true,
      loading: false,
      snapshot: null,
      rootCid: null,
      error: 'Invalid tree snapshot permalink',
    });
    return;
  }

  clearRetryTimer();
  const rootCid = await resolveSnapshotRootCid(snapshot, route.params.get('k'));
  if (token !== requestToken) {
    return;
  }

  permalinkSnapshotWritable.set({
    active: true,
    loading: false,
    snapshot,
    rootCid,
    error: rootCid ? null : 'Missing decryption key for tree snapshot',
  });
}

routeStore.subscribe((route) => {
  void updatePermalinkSnapshot(route);
});

export const permalinkSnapshotStore: Readable<PermalinkSnapshotState> = {
  subscribe: permalinkSnapshotWritable.subscribe,
};

export function getPermalinkSnapshotSync(): PermalinkSnapshotState {
  return get(permalinkSnapshotWritable);
}

export function isSnapshotPermalinkSync(route: RouteInfo = getRouteSync()): boolean {
  return isSnapshotPermalinkRoute(route);
}
