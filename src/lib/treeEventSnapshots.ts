import { nip19 } from 'nostr-tools';
import {
  toHex,
  type CID,
} from '@hashtree/core';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  HASHTREE_ROOT_KINDS,
  buildTreeEventSnapshotPermalink,
  compareTreeEventSnapshots as compareStoredTreeEventSnapshots,
  isNewerTreeEventSnapshot,
  readTreeEventSnapshot as readStoredTreeEventSnapshot,
  resolveSnapshotRootCid,
  snapshotMatchesRootCid,
  storeTreeEventSnapshot,
  type StoredNostrEvent,
  type TreeEventSnapshotInfo,
} from '@hashtree/nostr';
import { getTree } from '../store';
import { nostr } from '../nostr';

const SNAPSHOT_FETCH_LIMIT = 20;

const snapshotsByTreeKey = new Map<string, TreeEventSnapshotInfo>();
const snapshotsByEventId = new Map<string, TreeEventSnapshotInfo>();
const snapshotsBySnapshotHash = new Map<string, TreeEventSnapshotInfo>();
const treeSnapshotListeners = new Map<string, Set<(latest: TreeEventSnapshotInfo) => void>>();
const inFlightSnapshotReads = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const inFlightRootSnapshotLookups = new Map<string, Promise<TreeEventSnapshotInfo | null>>();
const ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS = 20_000;

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

function normalizeNostrEvent(event: NostrEvent): StoredNostrEvent | null {
  const raw = event as Partial<StoredNostrEvent>;
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
      if (existing !== snapshot) {
        for (const listener of [...(treeSnapshotListeners.get(treeKey) ?? [])]) listener(snapshot);
      }
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

export async function cacheTreeEventSnapshotFromNostrEvent(event: NostrEvent): Promise<TreeEventSnapshotInfo | null> {
  const normalized = normalizeNostrEvent(event);
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

/**
 * Follow a tree's signed root events. Each one is stored the moment it arrives
 * and the newest known is reported; nothing waits for relays to finish, and a
 * root this device signs itself is reported without a relay at all.
 */
export function watchLatestTreeEventSnapshot(
  npub: string,
  treeName: string,
  onLatest: (latest: TreeEventSnapshotInfo) => void,
  options: { live?: boolean } = {},
): () => void {
  let pubkey: string;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') return () => {};
    pubkey = decoded.data;
  } catch {
    return () => {};
  }

  const treeKey = getTreeKey(npub, treeName);
  const listeners = treeSnapshotListeners.get(treeKey) ?? new Set();
  treeSnapshotListeners.set(treeKey, listeners);
  listeners.add(onLatest);

  const sub = nostr.subscribe({
    kinds: [...HASHTREE_ROOT_KINDS] as number[],
    authors: [pubkey],
    '#d': [treeName],
    limit: SNAPSHOT_FETCH_LIMIT,
  }, { closeAfterHistory: !options.live });
  sub.on('event', (event) => {
    const normalized = normalizeNostrEvent(event);
    if (!normalized || normalized.pubkey !== pubkey) return;
    if (!normalized.tags.some((tag) => tag[0] === 'd' && tag[1] === treeName)) return;
    // Storing it notifies every watcher of this tree when it is the newest.
    void cacheTreeEventSnapshot(normalized).catch(() => {});
  });

  return () => {
    listeners.delete(onLatest);
    if (listeners.size === 0 && treeSnapshotListeners.get(treeKey) === listeners) {
      treeSnapshotListeners.delete(treeKey);
    }
    sub.stop();
  };
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

  // Resolves the moment the event for this root is seen. The time limit only
  // ends the background lookup; callers show their fallback link meanwhile.
  const lookup = new Promise<TreeEventSnapshotInfo | null>((resolve) => {
    let stop = () => {};
    let settled = false;
    const finish = (snapshot: TreeEventSnapshotInfo | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish(null), ROOT_SNAPSHOT_LOOKUP_TIMEOUT_MS);
    stop = watchLatestTreeEventSnapshot(npub, treeName, (latest) => {
      if (snapshotMatchesRootCid(latest, rootCid)) finish(latest);
    }, { live: true });
    if (settled) stop();
  });

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
