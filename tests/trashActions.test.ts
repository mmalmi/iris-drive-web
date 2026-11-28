import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';
import type { TrashItem } from '../src/lib/driveTrash';

const state = vi.hoisted(() => ({
  tree: null as unknown as HashTree, root: null as unknown as CID, owner: 'one', path: [] as string[],
  records: new Map<string, TrashItem>(), failArchive: false, toast: vi.fn(),
}));
vi.mock('../src/store', () => ({ getTree: () => state.tree }));
vi.mock('../src/nostr', () => ({
  nostrStore: { getState: () => ({ isLoggedIn: true, pubkey: state.owner, npub: state.owner }) },
}));
vi.mock('../src/utils/navigate', () => ({ navigate: vi.fn() }));
vi.mock('../src/utils/route', () => ({
  isNostrIdentityId: () => false,
  parseRoute: () => ({ npub: state.owner, treeName: 'main', path: state.path, params: new URLSearchParams() }),
}));
vi.mock('../src/actions/route', () => ({ getCurrentPathFromUrl: () => state.path, buildRouteUrl: vi.fn() }));
vi.mock('../src/drive/profileRoute', () => ({
  activeNostrIdentityRootScope: () => state.owner, isEditableDriveRouteScope: () => false,
}));
vi.mock('../src/drive/linkShareSync', () => ({ followLinkShares: () => [], putBackLinkShares: vi.fn() }));
vi.mock('../src/drive/linkShares', () => ({ linkSubjectAt: () => null }));
vi.mock('../src/drive/shareLibrary', () => ({ acceptedShares: { subscribe: (run: (items: unknown[]) => void) => { run([]); return () => {}; } } }));
vi.mock('../src/stores/recents', () => ({ moveRecents: () => [], putBackRecents: vi.fn() }));
vi.mock('../src/stores/toast', () => ({ showToast: state.toast, dismissToast: vi.fn(), toast: { error: vi.fn() } }));
vi.mock('../src/drive/driveRootChange', () => ({
  changeDriveRoot: async (_scope: string, _tree: string, write: (root: CID) => Promise<CID | null>) => {
    const next = await write(state.root);
    if (next) state.root = next;
    return !!next;
  },
}));
vi.mock('../src/lib/driveTrash', () => ({
  commitTrashDeletion: vi.fn(),
  archiveTrash: async (_tree: HashTree, rows: TrashItem[]) => {
    if (state.failArchive) throw new Error('out of space');
    for (const row of rows) state.records.set(row.id, row);
  },
  forgetTrash: async (ids: string[]) => { for (const id of ids) state.records.delete(id); },
  getTrash: async (id: string, account: string) => {
    const row = state.records.get(id);
    return row?.account === account ? row : undefined;
  },
  recoverContents: vi.fn(),
  rememberDestinations: (_account: string, paths: Map<string, string[]>) => {
    for (const [id, path] of paths) state.records.get(id)!.destination = path;
  },
}));

import { setDeletionHistoryOwner } from '../src/actions/deletionHistory';
import { deleteEntries, restoreTrashItems, undoLastDeletion } from '../src/actions/entry';

describe('moving files to Trash and restoring them', () => {
  beforeEach(async () => {
    setDeletionHistoryOwner(null);
    state.records.clear();
    state.failArchive = false;
    state.owner = 'one';
    state.path = ['folder'];
    state.tree = new HashTree({ store: new MemoryStore() });
    const file = await state.tree.putFile(new Uint8Array([1]));
    const folder = await state.tree.putDirectory([{ name: 'old.txt', type: LinkType.Blob, ...file }]);
    state.root = (await state.tree.putDirectory([{ name: 'folder', type: LinkType.Dir, ...folder }])).cid;
  });

  it('retains the original when archiving cannot finish', async () => {
    state.failArchive = true;
    const before = state.root;
    await expect(deleteEntries(['old.txt'])).rejects.toThrow('Could not save');
    expect(state.root).toBe(before);
    expect(state.records.size).toBe(0);
  });

  it('checks the active account again on Restore and keeps the record for its owner', async () => {
    await deleteEntries(['old.txt']);
    const ids = [...state.records.keys()];
    state.owner = 'two';
    await expect(restoreTrashItems('one', ids)).rejects.toThrow('edit access');
    await expect(restoreTrashItems('two', ids)).rejects.toThrow('no longer in Trash');
    expect(state.records.size).toBe(1);
  });

  it('keeps a file which took the place of a parent, restoring to its containing folder', async () => {
    await deleteEntries(['old.txt']);
    const [id] = state.records.keys();
    const file = await state.tree.putFile(new Uint8Array([2]));
    state.root = await state.tree.removeEntry(state.root, [], 'folder');
    state.root = await state.tree.setEntry(state.root, [], 'folder', file.cid, file.size, LinkType.Blob);
    const result = await restoreTrashItems('one', [id]);
    expect(result.get(id)).toEqual(['old.txt']);
    expect((await state.tree.resolvePath(state.root, ['folder']))!.cid).toEqual(file.cid);
    expect(await state.tree.resolvePath(state.root, ['old.txt'])).toBeTruthy();
    expect(state.records.size).toBe(0);
  });

  it('recognizes a previous restore which saved the file before the tab closed', async () => {
    await deleteEntries(['old.txt']);
    const [id, item] = [...state.records][0];
    item.destination = ['folder', 'old (2).txt'];
    const { entry } = item;
    state.root = await state.tree.setEntry(state.root, ['folder'], 'old (2).txt', entry.cid, entry.size, entry.type);
    const before = state.root;
    const result = await restoreTrashItems('one', [id]);
    expect(state.root).toBe(before);
    expect(result.get(id)).toEqual(item.destination);
    expect(state.records.size).toBe(0);
  });

  it('keeps only remaining items in Undo when Trash restore handles part of a batch', async () => {
    const file = await state.tree.putFile(new Uint8Array([2]));
    state.root = await state.tree.setEntry(state.root, ['folder'], 'next.txt', file.cid, file.size);
    await deleteEntries(['old.txt', 'next.txt']);
    const firstId = [...state.records.keys()][0];
    await restoreTrashItems('one', [firstId]);
    expect(undoLastDeletion()).toBe(true);
    await vi.waitFor(() => expect(state.records.size).toBe(0));
    expect(undoLastDeletion()).toBe(false);
    expect((await state.tree.listDirectory((await state.tree.resolvePath(state.root, ['folder']))!.cid)).map(item => item.name).sort())
      .toEqual(['next.txt', 'old.txt']);
  });

  it('drops keyboard history when leaving the account, preserving Trash for its owner', async () => {
    await deleteEntries(['old.txt']);
    setDeletionHistoryOwner(null);
    state.owner = 'two';
    setDeletionHistoryOwner('two');
    expect(undoLastDeletion()).toBe(false);
    state.owner = 'one';
    setDeletionHistoryOwner('one');
    expect(undoLastDeletion()).toBe(false);
    expect(state.records.size).toBe(1);
  });

  it.each([false, true])('keeps all bytes when restoring a folder and an earlier child (child first: %s)', async (childFirst) => {
    await deleteEntries(['old.txt']);
    const childId = [...state.records.keys()][0];
    const replacement = await state.tree.putFile(new Uint8Array([2]));
    state.root = await state.tree.setEntry(state.root, ['folder'], 'old.txt', replacement.cid, replacement.size);
    await deleteEntries(['folder'], []);
    const folderId = [...state.records.keys()].find(id => id !== childId)!;
    await restoreTrashItems('one', childFirst ? [childId, folderId] : [folderId, childId]);
    const original = await state.tree.resolvePath(state.root, ['folder', childFirst ? 'old.txt' : 'old (2).txt']);
    const replaced = await state.tree.resolvePath(state.root, [childFirst ? 'folder (2)' : 'folder', 'old.txt']);
    expect(await state.tree.readFile(original!.cid)).toEqual(new Uint8Array([1]));
    expect(await state.tree.readFile(replaced!.cid)).toEqual(new Uint8Array([2]));
    expect(state.records.size).toBe(0);
  });

});
