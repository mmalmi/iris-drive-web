import { describe, expect, it } from 'vitest';
import {
  HashTree,
  LinkType,
  MemoryStore,
  type CID,
} from '@hashtree/core';
import {
  moveProfileDriveEntries,
  mutateProfileDriveRoot,
  prepareProfileDriveRootForPublish,
} from '../src/drive/profileDriveMutation';

async function rootWithFiles(
  tree: HashTree,
  files: Record<string, string>,
): Promise<CID> {
  let root = (await tree.putDirectory([])).cid;
  for (const [path, content] of Object.entries(files)) {
    root = await mutateProfileDriveRoot(tree, root, { type: 'write', path, content }, {
      recordTombstones: false,
    });
  }
  return root;
}

async function tombstonePaths(tree: HashTree, root: CID): Promise<string[]> {
  return [...(await tombstoneTimestamps(tree, root)).keys()].sort();
}

async function tombstoneTimestamps(tree: HashTree, root: CID): Promise<Map<string, number>> {
  const tombstones = await tree.resolvePath(root, ['.hashtree', 'tombstones']);
  if (!tombstones || tombstones.type !== LinkType.Dir) return new Map();
  const timestamps = new Map<string, number>();
  const walk = async (cid: CID, prefix: string): Promise<void> => {
    for (const entry of await tree.listDirectory(cid)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === LinkType.Dir) await walk(entry.cid, path);
      else {
        const value = await tree.readFile(entry.cid);
        timestamps.set(path, Number(new TextDecoder().decode(value ?? undefined)));
      }
    }
  };
  await walk(tombstones.cid, '');
  return timestamps;
}

describe('profile Drive production mutations', () => {
  it('records a bulk move in one generation, including folder contents and retained deletions', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let root = await rootWithFiles(tree, {
      'Source/first.txt': 'first',
      'Source/Folder/child.txt': 'child',
      'Target/kept.txt': 'kept',
      'removed.txt': 'gone',
    });
    root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: 'removed.txt' });
    root = await prepareProfileDriveRootForPublish(tree, root);
    const previous = (await tombstoneTimestamps(tree, root)).get('removed.txt')!;
    const { root: moved } = await moveProfileDriveEntries(tree, root, ['Source'], ['first.txt', 'Folder'], ['Target']);
    const prepared = await prepareProfileDriveRootForPublish(tree, moved, root);
    const markers = await tombstoneTimestamps(tree, prepared);

    expect([...markers.keys()].sort()).toEqual(['Source/Folder', 'Source/Folder/child.txt', 'Source/first.txt', 'removed.txt']);
    expect(markers.get('removed.txt')).toBe(previous);
    const generation = markers.get('Source/first.txt')!;
    expect(generation).toBeGreaterThan(previous);
    expect(markers.get('Source/Folder')).toBe(generation);
    expect(markers.get('Source/Folder/child.txt')).toBe(generation);
    expect(await tree.resolvePath(prepared, ['Source', 'first.txt'])).toBeNull();
    expect(await tree.resolvePath(prepared, ['Source', 'Folder'])).toBeNull();
    for (const [from, to] of [
      ['Source/first.txt', 'Target/first.txt'],
      ['Source/Folder/child.txt', 'Target/Folder/child.txt'],
      ['Target/kept.txt', 'Target/kept.txt'],
    ]) {
      expect((await tree.resolvePath(prepared, to!))?.cid).toEqual((await tree.resolvePath(root, from!))?.cid);
    }
  });

  it('authors tombstones for delete, rename, and move source paths', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let root = await rootWithFiles(tree, {
      'delete/sub/file.txt': 'delete me',
      'rename/sub/file.txt': 'rename me',
      'move/file.txt': 'move me',
    });

    root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: 'delete' });
    root = await mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: 'rename',
      to: 'renamed',
    });
    root = await mutateProfileDriveRoot(tree, root, { type: 'mkdir', path: 'target' });
    root = await mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: 'move/file.txt',
      to: 'target/file.txt',
    });

    expect(await tombstonePaths(tree, root)).toEqual([
      'delete',
      'delete/sub',
      'delete/sub/file.txt',
      'move/file.txt',
      'rename',
      'rename/sub',
      'rename/sub/file.txt',
    ]);
    expect(await tree.resolvePath(root, ['renamed', 'sub', 'file.txt'])).not.toBeNull();
    expect(await tree.resolvePath(root, ['target', 'file.txt'])).not.toBeNull();
  });

  it('assigns a new marker generation to consecutive production mutations', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let root = await rootWithFiles(tree, {
      'first.txt': 'first',
      'second.txt': 'second',
    });
    root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: 'first.txt' });
    const firstGeneration = (await tombstoneTimestamps(tree, root)).get('first.txt')!;
    root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: 'second.txt' });
    const generations = await tombstoneTimestamps(tree, root);

    expect(generations.get('second.txt')).toBeGreaterThan(firstGeneration);
    expect(generations.get('first.txt')).toBe(firstGeneration);
  });

  it('re-layers retained tombstones after a metadata-free unrelated edit', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const original = await rootWithFiles(tree, {
      'removed.txt': 'gone',
      'kept.txt': 'kept',
    });
    const deleted = await mutateProfileDriveRoot(tree, original, {
      type: 'delete',
      path: 'removed.txt',
    });

    // Simulate the metadata-free logical root exposed by the Web projection.
    let visible = await rootWithFiles(tree, { 'kept.txt': 'kept' });
    visible = await mutateProfileDriveRoot(tree, visible, {
      type: 'write',
      path: 'unrelated.txt',
      content: 'later edit',
    }, { recordTombstones: false });
    const prepared = await prepareProfileDriveRootForPublish(tree, visible, deleted);

    expect(await tombstonePaths(tree, prepared)).toEqual(['removed.txt']);
    expect(await tree.resolvePath(prepared, ['unrelated.txt'])).not.toBeNull();
  });

  it('retains a deletion barrier when that path is recreated', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const original = await rootWithFiles(tree, { 'recreated.txt': 'old bytes' });
    const deleted = await mutateProfileDriveRoot(tree, original, {
      type: 'delete',
      path: 'recreated.txt',
    });
    const recreated = await rootWithFiles(tree, { 'recreated.txt': 'new bytes' });
    const prepared = await prepareProfileDriveRootForPublish(tree, recreated, deleted);

    expect(await tombstonePaths(tree, prepared)).toEqual(['recreated.txt']);
    const entry = await tree.resolvePath(prepared, ['recreated.txt']);
    expect(new TextDecoder().decode(await tree.readFile(entry!.cid) ?? undefined)).toBe('new bytes');
  });

  it('retains an empty-directory deletion barrier when the directory is recreated', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let original = (await tree.putDirectory([])).cid;
    original = await mutateProfileDriveRoot(tree, original, {
      type: 'mkdir',
      path: 'empty',
    });
    const deleted = await mutateProfileDriveRoot(tree, original, {
      type: 'delete',
      path: 'empty',
    });
    let recreated = (await tree.putDirectory([])).cid;
    recreated = await mutateProfileDriveRoot(tree, recreated, {
      type: 'mkdir',
      path: 'empty',
    }, { recordTombstones: false });

    const prepared = await prepareProfileDriveRootForPublish(tree, recreated, deleted);

    expect(await tombstonePaths(tree, prepared)).toEqual(['empty']);
    expect((await tree.resolvePath(prepared, ['empty']))?.type).toBe(LinkType.Dir);
  });
});
