import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';

const state = vi.hoisted(() => ({
  tree: null as unknown as HashTree,
  root: null as CID | null,
  path: [] as string[],
  save: vi.fn(),
  recents: vi.fn(() => []),
  navigate: vi.fn(),
}));
vi.mock('../src/store', () => ({ getTree: () => state.tree }));
vi.mock('../src/nostr', () => ({
  autosaveIfOwn: (root: CID) => { state.root = root; state.save(root); },
  nostrStore: { getState: () => ({}) },
}));
vi.mock('../src/utils/navigate', () => ({ navigate: state.navigate }));
vi.mock('../src/utils/route', () => ({
  parseRoute: () => ({ npub: 'owner', treeName: 'main', path: state.path, params: new URLSearchParams() }),
}));
vi.mock('../src/actions/route', () => ({
  getCurrentRootCid: () => state.root,
  getCurrentPathFromUrl: () => state.path,
  buildRouteUrl: (scope: string, tree: string, path: string[]) => `/${scope}/${tree}/${path.join('/')}`,
  updateRoute: vi.fn(),
}));
vi.mock('../src/drive/profileRoute', () => ({
  activeNostrIdentityRootScope: () => 'owner',
  isEditableDriveRouteScope: () => true,
}));
vi.mock('../src/drive/linkShareSync', () => ({ followLinkShares: () => [], putBackLinkShares: vi.fn() }));
vi.mock('../src/drive/linkShares', () => ({ linkSubjectAt: () => null }));
vi.mock('../src/drive/shareLibrary', () => ({ acceptedShares: { subscribe: (run: (value: unknown[]) => void) => { run([]); return () => {}; } } }));
vi.mock('../src/stores/recents', () => ({ moveRecents: state.recents, putBackRecents: vi.fn() }));
vi.mock('../src/drive/driveRootChange', () => ({
  changeDriveRoot: async (_scope: string, _tree: string, work: (root: CID) => Promise<CID | null>) => {
    const next = await work(state.root!);
    if (next) { state.root = next; state.save(next); }
    return !!next;
  },
}));
vi.mock('../src/stores/toast', () => ({ showToast: vi.fn(), toast: { error: vi.fn() } }));

import { moveEntriesTo } from '../src/actions/entry';

describe('saving a bulk move', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.path = [];
    state.tree = new HashTree({ store: new MemoryStore() });
    const file = await state.tree.putFile(new TextEncoder().encode('contents'));
    const target = await state.tree.putDirectory([]);
    state.root = (await state.tree.putDirectory([
      { name: 'a.txt', ...file, type: LinkType.Blob },
      { name: 'b.txt', ...file, type: LinkType.Blob },
      { name: 'Target', ...target, type: LinkType.Dir },
    ])).cid;
  });

  it('saves the selection once, follows every recent, and keeps the open file open', async () => {
    const existing = await state.tree.putFile(new TextEncoder().encode('already in Target'));
    state.root = await state.tree.setEntry(state.root!, ['Target'], 'b.txt', existing.cid, existing.size);
    state.path = ['b.txt'];
    await moveEntriesTo([], ['a.txt', 'b.txt'], ['Target']);
    expect((await state.tree.resolvePath(state.root!, ['Target', 'b.txt']))?.cid).toEqual(existing.cid);
    expect(await state.tree.resolvePath(state.root!, ['Target', 'b (2).txt'])).not.toBeNull();
    expect(state.save).toHaveBeenCalledTimes(1);
    expect(state.recents).toHaveBeenCalledTimes(2);
    expect(state.recents).toHaveBeenCalledWith('/owner/main/a.txt', '/owner/main/Target/a.txt');
    expect(state.recents).toHaveBeenCalledWith('/owner/main/b.txt', '/owner/main/Target/b (2).txt');
    expect(state.navigate).toHaveBeenCalledWith('/owner/main/Target/b (2).txt');
    for (const name of ['a.txt', 'b.txt']) {
      expect(await state.tree.resolvePath(state.root!, [name])).toBeNull();
      expect(await state.tree.resolvePath(state.root!, ['Target', name])).not.toBeNull();
    }
  });

  it('does not save or change recents when part of the selection is missing', async () => {
    const before = state.root;
    await expect(moveEntriesTo([], ['a.txt', 'missing.txt'], ['Target'])).rejects.toThrow('missing.txt');
    expect(state.save).not.toHaveBeenCalled();
    expect(state.recents).not.toHaveBeenCalled();
    expect(state.root).toBe(before);
  });

  it('leaves the whole cut selection in place when an item has changed since it was cut', async () => {
    const before = state.root;
    const expected = new Map([['a.txt', 'old-content'], ['b.txt', 'old-content']]);
    await expect(moveEntriesTo([], [...expected.keys()], ['Target'], expected)).rejects.toThrow('Select it again');
    expect(state.root).toBe(before);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.recents).not.toHaveBeenCalled();
  });

  it('keeps overlapping requests in order, with the second building on the first', async () => {
    await Promise.all([
      moveEntriesTo([], ['a.txt'], ['Target']),
      moveEntriesTo([], ['b.txt'], ['Target']),
    ]);
    expect(state.save).toHaveBeenCalledTimes(2);
    for (const name of ['a.txt', 'b.txt']) {
      expect(await state.tree.resolvePath(state.root!, [name])).toBeNull();
      expect(await state.tree.resolvePath(state.root!, ['Target', name])).not.toBeNull();
    }
  });
});
