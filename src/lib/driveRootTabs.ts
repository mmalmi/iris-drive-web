/**
 * Keeps the tabs of one browser on the same version of each Drive.
 *
 * Every tab of an account writes with the same device key, so relays and other
 * devices keep whichever version was published last. A tab that built a
 * version on an older one than another tab had already saved, or that only
 * republished an older version it still held, silently removed the other
 * tab's work.
 *
 * Each version a tab saves is announced: written to a shared record in
 * IndexedDB, which every tab reads consistently, and broadcast so open tabs
 * take it over at once. Writers that read the Drive, change it and save it
 * (document saves) do so under a lock shared by the tabs, reading the shared
 * record inside it, so two tabs never build on the same version.
 */
import { fromHex, toHex, type Hash, type TreeVisibility } from '@hashtree/core';
import { treeRootRegistry } from '../TreeRootRegistry';
import { keyValueStore } from './keyValueStore';

interface SharedRoot {
  key: string;
  /** Orders announcements; higher is newer. */
  seq: number;
  hash: string;
  rootKey?: string;
  visibility?: TreeVisibility;
}

const CHANNEL = 'iris-drive-roots';
const store = keyValueStore<SharedRoot>('iris-drive-tab-roots', 'roots');
const lastSeen = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
let channel: BroadcastChannel | null = null;

function rootKeyOf(scope: string, treeName: string): string {
  return `${scope}/${treeName}`;
}

function splitKey(key: string): [string, string] | null {
  const slash = key.indexOf('/');
  return slash > 0 ? [key.slice(0, slash), key.slice(slash + 1)] : null;
}

/** Takes over a version another tab saved, unless this tab has seen it or a newer one. */
function adopt(record: SharedRoot): void {
  if (record.seq <= (lastSeen.get(record.key) ?? 0)) return;
  lastSeen.set(record.key, record.seq);
  const parts = splitKey(record.key);
  if (!parts) return;
  const current = treeRootRegistry.getByKey(record.key);
  if (current && toHex(current.hash) === record.hash) return;
  treeRootRegistry.setLocal(parts[0], parts[1], fromHex(record.hash), {
    key: record.rootKey ? fromHex(record.rootKey) : undefined,
    visibility: record.visibility ?? current?.visibility,
  });
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<SharedRoot>) => {
    if (event.data && typeof event.data.key === 'string') adopt(event.data);
  };
}

/** Starts listening for versions other tabs save. */
export function startDriveRootTabSync(): void {
  ensureChannel();
}

/**
 * Tells the other tabs about a version this tab just saved. Resolves once the
 * shared record holds it.
 */
export function announceLocalRoot(scope: string, treeName: string, hash: Hash, rootKey?: Hash, visibility?: TreeVisibility): Promise<void> {
  ensureChannel();
  const key = rootKeyOf(scope, treeName);
  const seq = Math.max(Date.now(), (lastSeen.get(key) ?? 0) + 1);
  lastSeen.set(key, seq);
  const record: SharedRoot = { key, seq, hash: toHex(hash), rootKey: rootKey ? toHex(rootKey) : undefined, visibility };
  channel?.postMessage(record);
  const previous = pending.get(key) ?? Promise.resolve();
  const writing = previous
    .then(() => store.put(record))
    .catch((error: unknown) => {
      console.warn('[driveRootTabs] Could not share a Drive version with other tabs:', error);
    });
  pending.set(key, writing);
  return writing;
}

/** Whether no other tab has saved a different root since this one was queued. */
export async function isLatestAnnouncedRoot(scope: string, treeName: string, hash: Hash, rootKey?: Hash): Promise<boolean> {
  const key = rootKeyOf(scope, treeName);
  await pending.get(key);
  const shared = await store.get(key);
  return !shared || (shared.hash === toHex(hash) && shared.rootKey === (rootKey ? toHex(rootKey) : undefined));
}

/** Verify the exact destination is committed before releasing a recovery copy. Caller holds this Drive's lock. */
export async function keepRestoredDriveRoot(scope: string, treeName: string, hash: Hash, rootKey?: Hash): Promise<void> {
  const key = rootKeyOf(scope, treeName);
  await pending.get(key);
  const matches = (row?: SharedRoot) => row?.hash === toHex(hash) && row.rootKey === (rootKey ? toHex(rootKey) : undefined);
  if (matches(await store.get(key))) return;
  await announceLocalRoot(scope, treeName, hash, rootKey, 'private');
  if (!matches(await store.get(key))) throw new Error('Could not save the restored item on this device');
}

/**
 * Runs `write` while no other tab of this browser writes the same Drive, after
 * taking over the newest version any tab saved. `write` reads the Drive, saves
 * a new version and returns; the version is shared before the next tab goes.
 */
export async function withDriveRootLock<T>(scope: string, treeName: string, write: () => Promise<T>): Promise<T> {
  ensureChannel();
  const key = rootKeyOf(scope, treeName);
  const run = async (): Promise<T> => {
    try {
      const shared = await store.get(key);
      if (shared) adopt(shared);
    } catch (error) {
      console.warn('[driveRootTabs] Could not read the version other tabs saved:', error);
    }
    const result = await write();
    await (pending.get(key) ?? Promise.resolve());
    return result;
  };
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return run();
  return locks.request(`iris-drive-root:${key}`, run) as Promise<T>;
}
