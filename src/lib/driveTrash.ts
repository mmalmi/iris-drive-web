/** Recoverable contents stay on this browser, outside every shared tree and snapshot. */
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
  /** Written before restoring the tree, so retrying after an interruption is idempotent. */
  destination?: string[];
}

interface Block {
  hash: string;
  data: Uint8Array;
}

const db = new Dexie('iris-drive-trash');
db.version(1).stores({ items: 'id, account, deletedAt', blocks: 'hash', refs: '[item+hash], item, hash' });
const items: Table<TrashItem, string> = db.table('items');
const blocks: Table<Block, string> = db.table('blocks');
const refs: Table<{ item: string; hash: string }, [string, string]> = db.table('refs');
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('iris-drive-trash');
const changed = new EventTarget();

function notify(): void {
  changed.dispatchEvent(new Event('change'));
  channel?.postMessage(null);
}
export function watchTrash(run: () => void): () => void {
  changed.addEventListener('change', run);
  channel?.addEventListener('message', run);
  return () => {
    changed.removeEventListener('change', run);
    channel?.removeEventListener('message', run);
  };
}

export async function listTrash(account: string): Promise<TrashItem[]> {
  return (await items.where('account').equals(account).toArray())
    .filter(item => item.ready && item.deletedAt > Date.now() - TRASH_RETENTION)
    .sort((a, b) => b.deletedAt - a.deletedAt || a.entry.name.localeCompare(b.entry.name));
}

export async function forgetTrash(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.transaction('rw', items, blocks, refs, async () => {
    const entries = refs.where('item').anyOf(ids);
    const affected = new Set((await entries.toArray()).map(ref => ref.hash));
    await entries.delete();
    const kept = await refs.where('hash').anyOf([...affected]).uniqueKeys();
    for (const hash of kept) affected.delete(String(hash));
    await blocks.bulkDelete([...affected]);
    await items.bulkDelete(ids);
  });
  notify();
}

export async function expireTrash(): Promise<void> {
  const ids = await items.where('deletedAt').belowOrEqual(Date.now() - TRASH_RETENTION).primaryKeys();
  await forgetTrash(ids);
}

/** Save the actual blocks before removing the originals. Normal cache eviction cannot break Restore. */
export async function archiveTrash(tree: HashTree, records: TrashItem[]): Promise<void> {
  try {
    await items.bulkAdd(records);
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
  return row?.ready && row.account === account && row.deletedAt > Date.now() - TRASH_RETENTION ? row : undefined;
}

export async function rememberDestination(id: string, destination: string[]): Promise<void> {
  await items.update(id, { destination });
}

/** Copy back blocks a storage limit might have evicted since deletion. */
export async function recoverContents(tree: HashTree, item: TrashItem): Promise<void> {
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
