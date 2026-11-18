import { LinkType, toHex, type CID, type HashTree, type TreeEntry } from '@hashtree/core';

export const PRIVATE_TRASH = 'trash';
export const TRASH_SECONDS = 30 * 24 * 60 * 60;
const MAX_NOTE_BYTES = 1024 * 1024;
const slotId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PrivateTrashNote {
  v: 1;
  id: string;
  account: string;
  source_scope: string;
  tree_name: 'main';
  path: string[];
  deleted_at: number;
}
export interface PrivateTrashEntry { note: PrivateTrashNote; entry: TreeEntry; slot: TreeEntry }
export interface PrivateTrashTree { items: Map<string, PrivateTrashEntry>; removed: Map<string, { entry: TreeEntry; at: number }> }

export function canEncodeTrashPath(path: string[]): boolean {
  return path.length > 0 && path.every(part => typeof part === 'string' && !!part && part !== '.' && part !== '..'
    && part !== '.hashtree' && !/[/:\\\u0000]/u.test(part));
}
function unixTime(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function validNote(note: PrivateTrashNote, account: string, id: string): boolean {
  return note?.v === 1 && slotId.test(id) && note.id === id && note.account === account && note.source_scope === account
    && note.tree_name === 'main' && Array.isArray(note.path) && canEncodeTrashPath(note.path) && unixTime(note.deleted_at)
    && Object.keys(note).length === 7;
}
async function readJson(tree: HashTree, entry: TreeEntry | undefined) {
  if (!entry || entry.type !== LinkType.Blob || entry.size > MAX_NOTE_BYTES) throw new Error('Invalid Trash metadata');
  const bytes = await tree.readFile(entry.cid, { maxBytes: MAX_NOTE_BYTES });
  if (!bytes) throw new Error('Trash metadata is unavailable');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
async function jsonEntry(tree: HashTree, name: string, value: object): Promise<TreeEntry> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_NOTE_BYTES) throw new Error('Trash metadata is too large');
  return { name, type: LinkType.Blob, ...await tree.putFile(bytes) };
}
async function directory(tree: HashTree, name: string, entries: TreeEntry[]): Promise<TreeEntry> {
  return { name, type: LinkType.Dir, ...await tree.putDirectory(entries) };
}
export function sameTrashContent(a: TreeEntry, b: TreeEntry): boolean {
  return a.name === b.name && a.type === b.type && a.size === b.size && toHex(a.cid.hash) === toHex(b.cid.hash)
    && toHex(a.cid.key ?? new Uint8Array()) === toHex(b.cid.key ?? new Uint8Array());
}
/** Read all removal markers before any item. An offline writer can still have the old slot. */
export async function readPrivateTrash(tree: HashTree, account: string, heads: CID[], signal?: AbortSignal): Promise<PrivateTrashTree> {
  const view: PrivateTrashTree = { items: new Map(), removed: new Map() };
  const slots: TreeEntry[] = [];
  for (const head of heads) {
    if (!head.key) throw new Error('Invalid private Trash root');
    for (const slot of await tree.listDirectory(head, signal)) {
      if (slot.name === '.hashtree') continue;
      if (slot.type !== LinkType.Dir) throw new Error('Invalid Trash directory');
      if (slot.name !== 'removed') { slots.push(slot); continue; }
      for (const entry of await tree.listDirectory(slot.cid, signal)) {
        const marker = await readJson(tree, entry);
        if (marker?.v !== 1 || !slotId.test(entry.name) || marker.id !== entry.name || !unixTime(marker.removed_at)
          || Object.keys(marker).length !== 3) throw new Error('Invalid Trash removal');
        view.removed.set(entry.name, { entry, at: marker.removed_at });
      }
    }
  }
  for (const slot of slots) {
    if (view.removed.has(slot.name)) continue;
    const previous = view.items.get(slot.name);
    if (previous && sameTrashContent(previous.slot, slot)) continue;
    const entries = await tree.listDirectory(slot.cid, signal);
    const note = await readJson(tree, entries.find(entry => entry.name === 'item.json')) as PrivateTrashNote;
    const payload = entries.find(entry => entry.name === 'content');
    if (!validNote(note, account, slot.name) || payload?.type !== LinkType.Dir) throw new Error('Invalid Trash item');
    const contents = await tree.listDirectory(payload.cid, signal);
    if (contents.length !== 1 || contents[0].name !== note.path.at(-1)) throw new Error('Invalid Trash content');
    const entry = contents[0];
    if (previous && (!sameTrashContent(previous.entry, entry) || previous.note.deleted_at !== note.deleted_at
      || JSON.stringify(previous.note.path) !== JSON.stringify(note.path))) throw new Error('Conflicting Trash items');
    view.items.set(slot.name, { note, entry, slot });
  }
  return view;
}
export async function insertPrivateTrash(tree: HashTree, view: PrivateTrashTree, note: PrivateTrashNote, entry: TreeEntry): Promise<void> {
  if (!validNote(note, note.account, note.id) || note.path.at(-1) !== entry.name) throw new Error('Invalid Trash item');
  if (view.items.has(note.id) || view.removed.has(note.id)) throw new Error('Trash item already exists');
  const slot = await directory(tree, note.id, [await jsonEntry(tree, 'item.json', note), await directory(tree, 'content', [entry])]);
  view.items.set(note.id, { note, entry, slot });
}
export async function removePrivateTrash(tree: HashTree, view: PrivateTrashTree, id: string, removedAt: number): Promise<void> {
  if (!slotId.test(id) || !unixTime(removedAt)) throw new Error('Invalid Trash removal');
  if (!view.removed.has(id)) {
    const entry = await jsonEntry(tree, id, { v: 1, id, removed_at: removedAt });
    view.removed.set(id, { entry, at: removedAt });
  }
  view.items.delete(id);
}
export async function writePrivateTrash(tree: HashTree, view: PrivateTrashTree): Promise<CID> {
  const slots = Array.from(view.items.values(), item => item.slot);
  if (view.removed.size) slots.push(await directory(tree, 'removed', Array.from(view.removed.values(), mark => mark.entry)));
  return (await tree.putDirectory(slots)).cid;
}
