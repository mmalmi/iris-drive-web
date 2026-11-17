import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID, type TreeEntry } from '@hashtree/core';
import { moveEntriesInTree } from '../src/lib/moveEntries';

async function fixture(unencrypted = false) {
  const tree = new HashTree({ store: new MemoryStore() });
  const file = await tree.putFile(new TextEncoder().encode('keep these bytes'));
  const entries: TreeEntry[] = Array.from({ length: 100 }, (_, i) => ({
    name: `${i}.txt`, ...file, type: LinkType.Blob, meta: { modifiedAt: 123 },
  }));
  const source = await tree.putDirectory(entries, { unencrypted });
  const target = await tree.putDirectory([], { unencrypted });
  const root = (await tree.putDirectory([
    { name: 'Source', ...source, type: LinkType.Dir, meta: { label: 'source' } },
    { name: 'Target', ...target, type: LinkType.Dir, meta: { label: 'target' } },
  ], { unencrypted })).cid;
  return { tree, root, entries };
}

async function entriesAt(tree: HashTree, root: CID, path: string[]) {
  const folder = path.length ? (await tree.resolvePath(root, path))!.cid : root;
  return tree.listDirectory(folder);
}

describe('bulk moves', () => {
  it.each([false, true])('rewrites each affected directory once for 100 files (unencrypted: %s)', async (unencrypted) => {
    const { tree, root, entries } = await fixture(unencrypted);
    const writes = vi.spyOn(tree, 'putDirectory');
    const { root: moved } = await moveEntriesInTree(tree, root, ['Source'], entries.map(entry => entry.name), ['Target']);

    expect(writes).toHaveBeenCalledTimes(3);
    expect(await entriesAt(tree, moved, ['Source'])).toEqual([]);
    expect(await entriesAt(tree, moved, ['Target'])).toEqual(await entriesAt(tree, root, ['Source']));
    expect((await entriesAt(tree, moved, [])).map(entry => entry.meta)).toEqual([{ label: 'source' }, { label: 'target' }]);
    expect(!!moved.key).toBe(!unencrypted);
    expect(!!(await tree.resolvePath(moved, ['Target']))!.cid.key).toBe(!unencrypted);
    expect(await entriesAt(tree, root, ['Source'])).toHaveLength(100);
  });

  it('moves down from the root, then up to an ancestor, without losing either folder', async () => {
    const { tree, root, entries } = await fixture();
    const { root: up } = await moveEntriesInTree(tree, root, ['Source'], ['0.txt', '1.txt'], []);
    expect(await entriesAt(tree, up, ['Source'])).toHaveLength(98);
    const { root: down } = await moveEntriesInTree(tree, up, [], ['0.txt', '1.txt'], ['Source']);
    expect(await entriesAt(tree, down, ['Source'])).toHaveLength(entries.length);
    expect((await entriesAt(tree, down, [])).map(entry => entry.name)).toEqual(['Source', 'Target']);
  });

  it('moves folders with their contents and metadata unchanged, deduplicating names', async () => {
    const { tree, root } = await fixture();
    const before = (await entriesAt(tree, root, []))[0];
    const { root: moved } = await moveEntriesInTree(tree, root, [], ['Source', 'Source'], ['Target']);
    expect(await entriesAt(tree, moved, ['Target'])).toEqual([before]);
    expect(await entriesAt(tree, moved, ['Target', 'Source'])).toHaveLength(100);
  });

  it('keeps both versions and reserves original names for the other selected files', async () => {
    const { tree, root, entries } = await fixture();
    const original = await tree.putFile(new TextEncoder().encode('already here'));
    let setup = await tree.setEntry(root, ['Target'], '1.txt', original.cid, original.size);
    setup = await tree.setEntry(setup, ['Source'], '1 (2).txt', entries[0]!.cid, entries[0]!.size);
    const { root: moved } = await moveEntriesInTree(tree, setup, ['Source'], ['1.txt', '1 (2).txt'], ['Target']);
    expect((await tree.resolvePath(moved, ['Target', '1.txt']))?.cid).toEqual(original.cid);
    expect((await tree.resolvePath(moved, ['Target', '1 (3).txt']))?.cid).toEqual(entries[1]!.cid);
    expect(await tree.resolvePath(moved, ['Target', '1 (2).txt'])).not.toBeNull();
    expect(await tree.resolvePath(moved, ['Source', '1.txt'])).toBeNull();
  });

  it('numbers dotted folders and native documents while preserving both subtrees', async () => {
    const { tree, root } = await fixture();
    let setup = root;
    const names = ['Trip.2026', 'Notes.irisdoc'];
    const original = await tree.putDirectory([]);
    const incoming = (await tree.resolvePath(root, ['Source']))!;
    for (const name of names) {
      setup = await tree.setEntry(setup, [], name, incoming.cid, 0, LinkType.Dir);
      setup = await tree.setEntry(setup, ['Target'], name, original.cid, 0, LinkType.Dir);
    }
    const { root: moved, items } = await moveEntriesInTree(tree, setup, [], names, ['Target']);
    expect(items.map(item => item.destinationName)).toEqual(['Trip.2026 (2)', 'Notes (2).irisdoc']);
    for (const { entry, destinationName } of items) {
      expect((await tree.resolvePath(moved, ['Target', entry.name]))?.cid).toEqual(original.cid);
      expect((await tree.resolvePath(moved, ['Target', destinationName]))?.cid).toEqual(incoming.cid);
    }
  });

  it('rejects missing files, missing destinations, and moving a folder inside itself before writing', async () => {
    const { tree, root } = await fixture();
    const writes = vi.spyOn(tree, 'putDirectory');
    await expect(moveEntriesInTree(tree, root, ['Source'], ['0.txt', 'missing'], ['Target'])).rejects.toThrow('missing');
    await expect(moveEntriesInTree(tree, root, ['Source'], ['0.txt'], ['Missing'])).rejects.toThrow('That folder is no longer there');
    await expect(moveEntriesInTree(tree, root, [], ['Source'], ['Source'])).rejects.toThrow('inside itself');
    await expect(moveEntriesInTree(tree, root, [], ['Source'], ['Source', 'Nested'])).rejects.toThrow('inside itself');
    expect(writes).not.toHaveBeenCalled();
  });
});
