/** Durable local recovery copies and the pending changes to the account’s encrypted Trash. */
import Dexie, { type Table } from 'dexie';
import { fromHex, toHex, type HashTree, type TreeEntry } from '@hashtree/core';

export const TRASH_RETENTION = 30 * 24 * 60 * 60 * 1000;

export interface TrashItem {
  id: string;
  account: string;
  scope: string;
  treeName: string;
  path: string[];
  entry: TreeEntry;
  deletedAt: number;
  ready: boolean;
  /** Existing browser-only rows keep their old recovery policy. */
  sync?: 'prepared' | 'outgoing' | 'published' | 'remote';
  /** Written before restoring the tree, so retrying after an interruption is idempotent. */
  destination?: string[];
}

interface Block {
  hash: string;
  data: Uint8Array;
}

const db = new Dexie('iris-drive-trash');
db.version(1).stores({ items: 'id, account, deletedAt', blocks: 'hash', refs: '[item+hash], item, hash' });
db.version(2).stores({ markers: '[account+id], account', heads: '[account+writer]' });
interface TrashMarker { account: string; id: string; at: number; pending: boolean }
export const trashMarkers: Table<TrashMarker, [string, string]> = db.table('markers');
export const trashHeads: Table<{ account: string; writer: string; root: import('@hashtree/core').CID }, [string, string]> = db.table('heads');
const items: Table<TrashItem, string> = db.table('items');
const blocks: Table<Block, string> = db.table('blocks');
const refs: Table<{ item: string; hash: string }, [string, string]> = db.table('refs');
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('iris-drive-trash');
const listeners = new Set<(removedIds: string[]) => void>();

function changed(removedIds: string[]): void {
  for (const run of listeners) run(removedIds);
}
if (channel) channel.onmessage = event => changed(Array.isArray(event.data) ? event.data : []);

function notify(removedIds: string[] = []): void {
  changed(removedIds);
  channel?.postMessage(removedIds);
}
export function watchTrash(run: (removedIds: string[]) => void): () => void {
  listeners.add(run);
  return () => { listeners.delete(run); };
}

export async function listTrash(account: string): Promise<TrashItem[]> {
  return (await items.where('account').equals(account).toArray())
    .filter(item => item.sync !== 'prepared' && item.ready && item.deletedAt > Date.now() - TRASH_RETENTION)
    .sort((a, b) => b.deletedAt - a.deletedAt || a.entry.name.localeCompare(b.entry.name));
}

export async function forgetTrash(ids: string[], consume = false): Promise<void> {
  if (!ids.length) return;
  await db.transaction('rw', items, blocks, refs, trashMarkers, async () => {
    if (consume) {
      const pending: TrashMarker[] = [];
      const at = Math.floor(Date.now() / 1000);
      for (const item of await items.bulkGet(ids)) {
        if (item?.sync && item.sync !== 'prepared') pending.push({ account: item.account, id: item.id, at, pending: true });
      }
      await trashMarkers.bulkPut(pending);
    }
    const entries = refs.where('item').anyOf(ids);
    const affected = new Set((await entries.toArray()).map(ref => ref.hash));
    await entries.delete();
    const kept = await refs.where('hash').anyOf([...affected]).uniqueKeys();
    for (const hash of kept) affected.delete(String(hash));
    await blocks.bulkDelete([...affected]);
    await items.bulkDelete(ids);
  });
  notify(ids);
}

export async function expireTrash(): Promise<void> {
  const ids = await items.where('deletedAt').belowOrEqual(Date.now() - TRASH_RETENTION).primaryKeys();
  await forgetTrash(ids, true);
}

/** Save the actual blocks before removing the originals. Normal cache eviction cannot break Restore. */
export async function archiveTrash(tree: HashTree, records: TrashItem[]): Promise<void> {
  // Reserve the entire batch atomically. If an id already exists, this
  // attempt owns none of those rows and must never clean up their blocks.
  await db.transaction('rw', items, () => items.bulkAdd(records));
  try {
    for (const record of records) {
      let batch: Block[] = [];
      const keep = async () => {
        await db.transaction('rw', refs, blocks, async () => {
          const hashes = batch.map(block => block.hash);
          const known = new Set(await blocks.where('hash').anyOf(hashes).primaryKeys());
          await blocks.bulkAdd(batch.filter(block => !known.has(block.hash)));
          await refs.bulkAdd(hashes.map(hash => ({ item: record.id, hash })));
        });
        batch = [];
      };
      for await (const { hash, data } of tree.walkBlocks(record.entry.cid)) {
        batch.push({ hash: toHex(hash), data });
        if (batch.length >= 8) await keep();
      }
      if (batch.length) await keep();
    }
    await items.bulkPut(records.map(record => ({ ...record, ready: true })));
    notify();
  } catch (error) {
    await forgetTrash(records.map(record => record.id));
    throw error;
  }
}

export async function getTrash(id: string, account: string): Promise<TrashItem | undefined> {
  const row = await items.get(id);
  return row?.ready && row.sync !== 'prepared' && row.account === account && row.deletedAt > Date.now() - TRASH_RETENTION ? row : undefined;
}

export async function rememberDestinations(account: string, destinations: Map<string, string[]>): Promise<void> {
  if (!destinations.size) return;
  await db.transaction('rw', items, trashMarkers, async () => {
    const ids = [...destinations.keys()];
    const [rows, markers] = await Promise.all([
      items.bulkGet(ids), trashMarkers.bulkGet(ids.map(id => [account, id])),
    ]);
    if (markers.some(Boolean)) throw new Error('This item is no longer in Trash');
    const updated = rows.map(row => {
      if (!row || row.account !== account) throw new Error('This item is no longer in Trash');
      return { ...row, destination: destinations.get(row.id)! };
    });
    await items.bulkPut(updated);
  });
}

/** Copy back blocks a storage limit might have evicted since deletion. */
export async function recoverContents(tree: HashTree, item: TrashItem): Promise<void> {
  if (item.sync === 'remote') {
    // Fetch and verify the complete retained graph before consuming this item.
    for await (const block of tree.walkBlocks(item.entry.cid)) {
      if (!block.data) throw new Error('The saved content is unavailable');
    }
    return;
  }
  const store = tree.getStore();
  const keys = (await refs.where('item').equals(item.id).toArray()).map(ref => ref.hash);
  if (!keys.length) throw new Error('The saved content is unavailable');
  for (let start = 0; start < keys.length; start += 8) {
    const batch = await blocks.bulkGet(keys.slice(start, start + 8));
    for (const row of batch) {
      if (!row) throw new Error('The saved content is unavailable');
      const hash = fromHex(row.hash);
      if (!await store.has(hash)) await store.put(hash, row.data);
    }
  }
}

export function privateTrashRows(account: string): Promise<TrashItem[]> {
  return items.where('account').equals(account).filter(item => !!item.sync).toArray();
}

export async function commitTrashDeletion(ids: string[]): Promise<void> {
  if (await items.where('id').anyOf(ids).filter(item => item.sync === 'prepared').modify({ sync: 'outgoing' })) notify();
}

/** The archive and the destination journal survive separately from the remotely fetched listing. */
export async function applyTrashListing(account: string, rows: TrashItem[], removed: Map<string, number>): Promise<void> {
  let dirty = false;
  const forgotten: string[] = [];
  await db.transaction('rw', items, trashMarkers, blocks, refs, async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [id, at] of removed) {
      const marker = await trashMarkers.get([account, id]);
      if (!marker) await trashMarkers.put({ account, id, at, pending: false });
      const row = await items.get(id);
      if (row?.account === account && row.sync) forgotten.push(id);
    }
    for (const row of rows) {
      if (row.deletedAt <= (now * 1000) - TRASH_RETENTION || await trashMarkers.get([account, row.id])) continue;
      const existing = await items.get(row.id);
      if (!existing) { await items.add(row); dirty = true; }
    }
    if (forgotten.length) await forgetTrash(forgotten);
  });
  if (dirty || forgotten.length) notify(forgotten);
}
export async function publishedTrash(account: string, rows: TrashItem[], markers: TrashMarker[]): Promise<void> {
  await db.transaction('rw', items, trashMarkers, async () => {
    for (const row of rows) {
      const current = await items.get(row.id);
      if (current?.account === account && current.sync === 'outgoing') await items.update(row.id, { sync: 'published' });
    }
    for (const mark of markers) await trashMarkers.update([account, mark.id], { pending: false });
  });
}
