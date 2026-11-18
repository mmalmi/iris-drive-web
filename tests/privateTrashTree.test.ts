import { expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, fromHex, toHex, type CID } from '@hashtree/core';
import nativeTree from './fixtures/native-trash-tree-v1.json';
import fixture from './fixtures/private-trash-v1.json';
import { insertPrivateTrash, readPrivateTrash, removePrivateTrash, writePrivateTrash, type PrivateTrashNote } from '../src/drive/privateTrashTree';

const note = fixture.item as PrivateTrashNote;
it('opens the native encrypted tree, preserves its exact bytes, and hides a consumed item on stale replay', async () => {
  const store = new MemoryStore();
  const tree = new HashTree({ store });
  for (const [hash, data] of Object.entries(nativeTree.blocks)) await store.put(fromHex(hash), fromHex(data));
  const root = { hash: fromHex(nativeTree.root_hash), key: fromHex(nativeTree.root_key) };
  const view = await readPrivateTrash(tree, note.account, [root]);
  const value = view.items.get(note.id)!;
  expect(value.note).toEqual(note);
  expect(new TextDecoder().decode((await tree.readFile(value.entry.cid))!)).toBe(fixture.content_utf8);
  await removePrivateTrash(tree, view, note.id, fixture.marker.removed_at);
  const consumed = await writePrivateTrash(tree, view);
  expect(await tree.resolvePath(consumed, [note.id])).toBeNull();
  for (const heads of [[root, consumed], [consumed, root]]) {
    expect((await readPrivateTrash(tree, note.account, heads)).items.size).toBe(0);
  }
  await expect(readPrivateTrash(tree, crypto.randomUUID(), [root])).rejects.toThrow('Invalid Trash item');
});
it('writes the shared fixture using the web writer', async () => {
  const tree = new HashTree({ store: new MemoryStore() });
  const entry = { name: note.path.at(-1)!, type: LinkType.Blob, ...await tree.putFile(new TextEncoder().encode(fixture.content_utf8)) };
  const view = await readPrivateTrash(tree, note.account, []);
  await insertPrivateTrash(tree, view, note, entry);
  const root: CID = await writePrivateTrash(tree, view);
  const opened = (await readPrivateTrash(tree, note.account, [root])).items.get(note.id)!;
  expect(opened.entry.cid).toEqual(entry.cid);
  const blocks: Record<string, string> = {};
  for await (const { hash, data } of tree.walkBlocks(root)) blocks[toHex(hash)] = toHex(data);
  if (process.env.WEB_TRASH_FIXTURE_OUTPUT) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.WEB_TRASH_FIXTURE_OUTPUT, JSON.stringify({ root_hash: toHex(root.hash), root_key: toHex(root.key!), blocks }, null, 2) + '\n');
  }
});

it('lists a folder without downloading its contents', async () => {
  const store = new MemoryStore();
  const tree = new HashTree({ store });
  const bytes = new Uint8Array(1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += 1024) bytes[offset] = offset / 1024;
  const file = await tree.putFile(bytes);
  const folder = await tree.putDirectory([{ name: 'photo.bin', type: LinkType.Blob, ...file }]);
  const entry = { name: 'Photos', type: LinkType.Dir, ...folder };
  const view = await readPrivateTrash(tree, note.account, []);
  await insertPrivateTrash(tree, view, { ...note, path: ['Photos'] }, entry);
  const root = await writePrivateTrash(tree, view);
  const payload = new Set<string>();
  for await (const block of tree.walkBlocks(folder.cid)) payload.add(toHex(block.hash));
  const read = store.get.bind(store);
  store.get = async hash => {
    if (payload.has(toHex(hash))) throw new Error('Listing tried to fetch deleted contents');
    return read(hash);
  };
  expect((await readPrivateTrash(new HashTree({ store }), note.account, [root])).items.get(note.id)?.entry.cid).toEqual(folder.cid);
});
