import { nip19, SimplePool } from 'nostr-tools';
import {
  toHex,
  type CID,
} from '@hashtree/core';
import type { NDKEvent, NDKKind } from 'ndk';
import {
  HASHTREE_ROOT_KINDS,
  buildTreeEventSnapshotPermalink,
  compareTreeEventSnapshots as compareStoredTreeEventSnapshots,
  fetchLatestTreeEventSnapshot as fetchStoredLatestTreeEventSnapshot,
  isNewerTreeEventSnapshot,
  readTreeEventSnapshot as readStoredTreeEventSnapshot,
  resolveSnapshotRootCid,
  snapshotMatchesRootCid,
  storeTreeEventSnapshot,
  type StoredNostrEvent,
  type TreeEventSnapshotInfo,
} from '@hashtree/nostr';
import { getTree } from '../store';
import { ndk } from '../nostr';

const SNAPSHOT_FETCH_TIMEOUT_MS = 5000;
const SNAPSHOT_FETCH_LIMIT = 20;

const snapshotsByTreeKey = new Map<string, TreeEventSnapshotInfo>();
const snapshotsByEventId = new Map<string, TreeEventSnapshotInfo>();
const snapshotsBySnapshotHash = new Map<string, TreeEventSnapshotInfo>();
const inFlightTreeLookups = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const inFlightSnapshotReads = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const inFlightRootSnapshotLookups = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS = 20_000;
const ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS = 500;

export type { TreeEventSnapshotInfo };
export { isNewerTreeEventSnapshot, snapshotMatchesRootCid, resolveSnapshotRootCid };

function getSnapshotHashKey(snapshotCid: CID): string {
  return toHex(snapshotCid.hash);
}

function getTreeKey(npub: string, treeName: string): string {
  return `${npub}/${treeName}`;
}

function getRootSnapshotLookupKey(npub: string, treeName: string, rootCid: CID): string {
  return `${getTreeKey(npub, treeName)}:${toHex(rootCid.hash)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const compareTreeEventSnapshots = compareStoredTreeEventSnapshots;

function normalizeRawEvent(event: Pick<StoredNostrEvent, 'id' | 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content' | 'sig'>): StoredNostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function normalizeNdkEvent(event: NDKEvent): StoredNostrEvent | null {
  const raw = event.rawEvent() as Partial<StoredNostrEvent>;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.pubkey !== 'string' ||
    typeof raw.created_at !== 'number' ||
    typeof raw.kind !== 'number' ||
    !Array.isArray(raw.tags) ||
    typeof raw.content !== 'string' ||
    typeof raw.sig !== 'string'
  ) {
    return null;
  }
  return normalizeRawEvent(raw as StoredNostrEvent);
}

function registerSnapshot(
  snapshot: TreeEventSnapshotInfo,
  options: { updateTreeKey?: boolean } = {},
): TreeEventSnapshotInfo {
  snapshotsByEventId.set(snapshot.event.id, snapshot);
  snapshotsBySnapshotHash.set(getSnapshotHashKey(snapshot.snapshotCid), snapshot);

  if (options.updateTreeKey !== false) {
    const treeKey = getTreeKey(snapshot.npub, snapshot.treeName);
    const existing = snapshotsByTreeKey.get(treeKey);
    if (!existing || compareStoredTreeEventSnapshots(existing, snapshot) <= 0) {
      snapshotsByTreeKey.set(treeKey, snapshot);
    }
  }

  return snapshot;
}

export async function cacheTreeEventSnapshot(event: StoredNostrEvent): Promise<TreeEventSnapshotInfo | null> {
  const existing = snapshotsByEventId.get(event.id);
  if (existing) {
    return registerSnapshot(existing, { updateTreeKey: true });
  }

  const snapshot = await storeTreeEventSnapshot(getTree(), nip19, event);
  if (!snapshot) {
    return null;
  }
  return registerSnapshot(snapshot, { updateTreeKey: true });
}

export async function cacheTreeEventSnapshotFromNdkEvent(event: NDKEvent): Promise<TreeEventSnapshotInfo | null> {
  const normalized = normalizeNdkEvent(event);
  if (!normalized) return null;
  return cacheTreeEventSnapshot(normalized);
}

export function getCachedTreeEventSnapshot(npub: string | null | undefined, treeName: string | null | undefined): TreeEventSnapshotInfo | null {
  if (!npub || !treeName) return null;
  return snapshotsByTreeKey.get(getTreeKey(npub, treeName)) ?? null;
}

export async function readTreeEventSnapshot(snapshotCid: CID): Promise<TreeEventSnapshotInfo | null> {
  const hashKey = getSnapshotHashKey(snapshotCid);
  const cached = snapshotsBySnapshotHash.get(hashKey);
  if (cached) {
    return cached;
  }

  const inFlight = inFlightSnapshotReads.get(hashKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    try {
      const snapshot = await readStoredTreeEventSnapshot(getTree(), nip19, snapshotCid);
      if (!snapshot) {
        return null;
      }
      return registerSnapshot(snapshot, { updateTreeKey: false });
    } catch {
      return null;
    }
  })();

  inFlightSnapshotReads.set(hashKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightSnapshotReads.delete(hashKey);
  }
}

async function fetchTreeEvents(pubkey: string, treeName: string): Promise<StoredNostrEvent[]> {
  const ndkEvents = await ndk.fetchEvents({
    kinds: [...HASHTREE_ROOT_KINDS] as NDKKind[],
    authors: [pubkey],
    '#d': [treeName],
    limit: SNAPSHOT_FETCH_LIMIT,
  }).catch(() => null);

  const candidates: StoredNostrEvent[] = [];
  for (const event of ndkEvents ?? []) {
    const normalized = normalizeNdkEvent(event);
    if (!normalized) continue;
    candidates.push(normalized);
  }

  if (candidates.length > 0) {
    return candidates;
  }

  const relayUrls = typeof ndk.pool?.urls === 'function' ? ndk.pool.urls() : [];
  if (relayUrls.length === 0) {
    return [];
  }

  const pool = new SimplePool();
  try {
    const rawEvents = await pool.querySync(relayUrls, {
      kinds: [...HASHTREE_ROOT_KINDS],
      authors: [pubkey],
      '#d': [treeName],
      limit: SNAPSHOT_FETCH_LIMIT,
    }, {
      maxWait: SNAPSHOT_FETCH_TIMEOUT_MS,
    });
    for (const raw of rawEvents) {
      const normalized = normalizeRawEvent(raw as StoredNostrEvent);
      candidates.push(normalized);
    }
    return candidates;
  } catch {
    return [];
  } finally {
    try {
      pool.destroy();
    } catch {}
  }
}

async function fetchLatestTreeEventSnapshot(npub: string, treeName: string): Promise<TreeEventSnapshotInfo | null> {
  return fetchStoredLatestTreeEventSnapshot(
    {
      snapshotTarget: getTree(),
      nip19,
      snapshotFetchLimit: SNAPSHOT_FETCH_LIMIT,
      fetchEvents: async (filter) => {
        const author = filter.authors?.[0];
        const dTag = filter['#d']?.[0];
        if (!author || !dTag) {
          return [];
        }
        return fetchTreeEvents(author, dTag);
      },
    },
    npub,
    treeName,
  );
}

export async function ensureLatestTreeEventSnapshot(npub: string, treeName: string): Promise<TreeEventSnapshotInfo | null> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (cached) {
    return cached;
  }

  const treeKey = getTreeKey(npub, treeName);
  const inFlight = inFlightTreeLookups.get(treeKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    try {
      return await fetchLatestTreeEventSnapshot(npub, treeName);
    } catch {
      return null;
    }
  })();

  inFlightTreeLookups.set(treeKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightTreeLookups.delete(treeKey);
  }
}

export async function ensureTreeEventSnapshotForRoot(
  npub: string,
  treeName: string,
  rootCid: CID,
): Promise<TreeEventSnapshotInfo | null> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (snapshotMatchesRootCid(cached, rootCid)) {
    return cached;
  }

  const lookupKey = getRootSnapshotLookupKey(npub, treeName, rootCid);
  const inFlight = inFlightRootSnapshotLookups.get(lookupKey);
  if (inFlight) {
    return inFlight;
  }

  const lookup = (async (): Promise<TreeEventSnapshotInfo | null> => {
    const deadline = Date.now() + ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS;
    let nextFetchAt = 0;

    while (Date.now() <= deadline) {
      const nextCached = getCachedTreeEventSnapshot(npub, treeName);
      if (snapshotMatchesRootCid(nextCached, rootCid)) {
        return nextCached;
      }

      if (Date.now() >= nextFetchAt) {
        const latest = await fetchLatestTreeEventSnapshot(npub, treeName).catch(() => null);
        if (snapshotMatchesRootCid(latest, rootCid)) {
          return latest;
        }
        nextFetchAt = Date.now() + ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS;
      }

      if (Date.now() + ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS > deadline) {
        break;
      }
      await sleep(ROOT_SNAPSHOT_LOOKUP_INTERVAL_MS);
    }

    return null;
  })();

  inFlightRootSnapshotLookups.set(lookupKey, lookup);
  try {
    return await lookup;
  } finally {
    inFlightRootSnapshotLookups.delete(lookupKey);
  }
}

export function buildTreeEventPermalink(
  snapshot: TreeEventSnapshotInfo,
  path: string[] = [],
  linkKey?: string | null,
): string {
  return buildSnapshotHref(snapshot.snapshotNhash, path, linkKey);
}

function buildSnapshotHref(
  snapshotNhash: string,
  path: string[] = [],
  linkKey?: string | null,
): string {
  return `#/${buildTreeEventSnapshotPermalink({
    snapshotNhash,
    path,
    ...(linkKey ? { linkKey } : {}),
  })}`;
}

async function getWorkerSnapshotNhash(npub: string, treeName: string): Promise<string | null> {
  try {
    const { getWorkerAdapter, waitForWorkerAdapter } = await import('../lib/workerInit');
    const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(250);
    if (!adapter || !('getTreeRootInfo' in adapter)) {
      return null;
    }

    const treeRootInfo = await adapter.getTreeRootInfo(npub, treeName);
    const snapshotNhash = treeRootInfo?.snapshotNhash?.trim();
    return snapshotNhash || null;
  } catch {
    return null;
  }
}

export function buildTreeRouteHref(
  npub: string,
  treeName: string,
  path: string[] = [],
  linkKey?: string | null,
): string {
  const encodedParts = [npub, treeName, ...path].map(encodeURIComponent).join('/');
  const query = new URLSearchParams();
  if (linkKey) {
    query.set('k', linkKey);
  }
  const suffix = query.toString();
  return `#/${encodedParts}${suffix ? `?${suffix}` : ''}`;
}

export async function buildPreferredTreeEventHref(
  npub: string,
  treeName: string,
  path: string[] = [],
  linkKey?: string | null,
): Promise<string> {
  const cached = getCachedTreeEventSnapshot(npub, treeName);
  if (cached) {
    return buildTreeEventPermalink(cached, path, linkKey);
  }
  const workerSnapshotNhash = await getWorkerSnapshotNhash(npub, treeName);
  if (workerSnapshotNhash) {
    return buildSnapshotHref(workerSnapshotNhash, path, linkKey);
  }
  const latest = await ensureLatestTreeEventSnapshot(npub, treeName);
  if (latest) {
    return buildTreeEventPermalink(latest, path, linkKey);
  }
  return buildTreeRouteHref(npub, treeName, path, linkKey);
}
