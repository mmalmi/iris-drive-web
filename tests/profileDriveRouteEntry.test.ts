import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';
import { prepareProfileDriveRootForPublish } from '../src/drive/profileDriveMutation';
import { readPathKindReplacements } from '../src/drive/profileDrivePathKindMetadata';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174170';
const OTHER_PROFILE_ID = '223e4567-e89b-42d3-a456-426614174170';
const APP_KEY = 'a'.repeat(64);
const mocks = vi.hoisted(() => ({
  session: null as null | {
    status: 'active';
    profileId: string;
    appKeyPubkey: string;
  },
}));

vi.mock('../src/nostr/auth', () => ({
  getCurrentNostrIdentitySession: () => mocks.session,
}));

import { markFolderChanged, setEntriesForDriveRoute, setEntryForDriveRoute } from '../src/drive/profileDriveRouteEntry';

const ACTIVE_STATE = { isLoggedIn: true, pubkey: APP_KEY };

describe('profile Drive route entry writes', () => {
  beforeEach(() => {
    mocks.session = {
      status: 'active',
      profileId: PROFILE_ID,
      appKeyPubkey: APP_KEY,
    };
  });

  it('keeps restored directory contents when the same batch writes a descendant', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const kept = await tree.putFile(new TextEncoder().encode('keep me'));
    const folder = await tree.putDirectory([{ name: 'kept.txt', ...kept, type: LinkType.Blob }]);
    const added = await tree.putFile(new TextEncoder().encode('add me'));
    const root = (await tree.putDirectory([])).cid;
    const next = await setEntriesForDriveRoute(tree, root, [
      { parentPath: [], name: 'Restored', entry: { ...folder, type: LinkType.Dir } },
      { parentPath: ['Restored'], name: 'added.txt', entry: { ...added, type: LinkType.Blob } },
    ], { npub: PROFILE_ID, treeName: 'main' }, ACTIVE_STATE);
    expect((await tree.resolvePath(next, ['Restored', 'kept.txt']))?.cid).toEqual(kept.cid);
    expect((await tree.resolvePath(next, ['Restored', 'added.txt']))?.cid).toEqual(added.cid);
  });

  it('routes a production file-over-folder write through an exact durable role', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const child = await tree.putFile(new TextEncoder().encode('old child'));
    const directory = await tree.putDirectory([{
      name: 'child.txt',
      cid: child.cid,
      size: child.size,
      type: LinkType.Blob,
    }]);
    let root = (await tree.putDirectory([{
      name: 'draft',
      cid: directory.cid,
      size: 0,
      type: LinkType.Dir,
    }])).cid;
    const replacement = await tree.putFile(new TextEncoder().encode('replacement'));

    root = await setEntryForDriveRoute(
      tree,
      root,
      [],
      'draft',
      { cid: replacement.cid, size: replacement.size, type: LinkType.Blob },
      { npub: PROFILE_ID, treeName: 'main' },
      ACTIVE_STATE,
    );
    root = await prepareProfileDriveRootForPublish(tree, root);

    const tombstones = await readTombstones(tree, root);
    const roles = (await readPathKindReplacements(tree, root)).roles;
    expect([...tombstones.keys()]).toEqual(['draft']);
    expect(roles.get('draft')).toBe(tombstones.get('draft'));
    expect((await tree.resolvePath(root, ['draft']))?.type).toBe(LinkType.Blob);
  });

  it('routes a production folder-over-file write through an exact durable role', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const oldFile = await tree.putFile(new TextEncoder().encode('old file'));
    let root = (await tree.putDirectory([{
      name: 'draft',
      cid: oldFile.cid,
      size: oldFile.size,
      type: LinkType.Blob,
    }])).cid;
    const nested = await tree.putFile(new TextEncoder().encode('new child'));
    const replacement = await tree.putDirectory([{
      name: 'child.txt',
      cid: nested.cid,
      size: nested.size,
      type: LinkType.Blob,
    }]);

    root = await setEntryForDriveRoute(
      tree,
      root,
      [],
      'draft',
      { cid: replacement.cid, size: 0, type: LinkType.Dir },
      { npub: PROFILE_ID, treeName: 'main' },
      ACTIVE_STATE,
    );
    root = await prepareProfileDriveRootForPublish(tree, root);

    const tombstones = await readTombstones(tree, root);
    const roles = (await readPathKindReplacements(tree, root)).roles;
    expect([...tombstones.keys()]).toEqual(['draft']);
    expect(roles.get('draft')).toBe(tombstones.get('draft'));
    expect((await tree.resolvePath(root, ['draft']))?.type).toBe(LinkType.Dir);
    expect(await tree.resolvePath(root, ['draft', 'child.txt'])).not.toBeNull();
  });

  it('preserves ordinary HashTree behavior outside the active profile UUID', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const oldDirectory = await tree.putDirectory([]);
    let root = (await tree.putDirectory([{
      name: 'draft',
      cid: oldDirectory.cid,
      size: 0,
      type: LinkType.Dir,
    }])).cid;
    const replacement = await tree.putFile(new TextEncoder().encode('legacy write'));

    root = await setEntryForDriveRoute(
      tree,
      root,
      [],
      'draft',
      { cid: replacement.cid, size: replacement.size, type: LinkType.Blob },
      { npub: OTHER_PROFILE_ID, treeName: 'main' },
      ACTIVE_STATE,
    );

    expect(await tree.resolvePath(root, ['.hashtree'])).toBeNull();
    expect((await tree.resolvePath(root, ['draft']))?.type).toBe(LinkType.Blob);
  });

  it('does not erase an existing profile directory during ensure-style uploads', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const child = await tree.putFile(new TextEncoder().encode('keep me'));
    const existing = await tree.putDirectory([{
      name: 'kept.txt',
      cid: child.cid,
      size: child.size,
      type: LinkType.Blob,
    }]);
    const root = (await tree.putDirectory([{
      name: 'upload',
      cid: existing.cid,
      size: 0,
      type: LinkType.Dir,
    }])).cid;
    const empty = await tree.putDirectory([]);

    const unchanged = await setEntryForDriveRoute(
      tree,
      root,
      [],
      'upload',
      { cid: empty.cid, size: 0, type: LinkType.Dir },
      { npub: PROFILE_ID, treeName: 'main' },
      ACTIVE_STATE,
    );

    expect(unchanged).toEqual(root);
    expect(await tree.resolvePath(unchanged, ['upload', 'kept.txt'])).not.toBeNull();
  });
});

describe('when an item last changed', () => {
  const plainRoute = { npub: 'npub1someone', treeName: 'notes' };
  const modified = async (tree: HashTree, root: CID, path: string[]) => {
    const parent = path.length > 1 ? (await tree.resolvePath(root, path.slice(0, -1)))!.cid : root;
    return (await tree.listDirectory(parent)).find((entry) => entry.name === path.at(-1))?.meta?.modified_at;
  };

  beforeEach(() => {
    mocks.session = { status: 'active', profileId: PROFILE_ID, appKeyPubkey: APP_KEY };
  });

  it('is stamped on what is written, in a profile Drive and in a plain tree, keeping other details', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const file = await tree.putFile(new TextEncoder().encode('hello'));
    const before = Math.floor(Date.now() / 1000);
    for (const route of [{ npub: PROFILE_ID, treeName: 'main' }, plainRoute]) {
      const root = await setEntryForDriveRoute(
        tree,
        (await tree.putDirectory([])).cid,
        ['Trip'],
        'hello.txt',
        { cid: file.cid, size: file.size, type: LinkType.Blob, meta: { whole_file_hash: 'ab' } },
        route,
        ACTIVE_STATE,
      );
      const parent = (await tree.resolvePath(root, ['Trip']))!;
      const [entry] = await tree.listDirectory(parent.cid);
      expect(entry.meta?.whole_file_hash).toBe('ab');
      expect(entry.meta?.modified_at).toBeGreaterThanOrEqual(before);
    }
  });

  it('is moved forward on a folder when something inside it is saved, as a document is', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const inner = await tree.putFile(new TextEncoder().encode('first'));
    const documentFolder = await tree.putDirectory([{ name: 'a', cid: inner.cid, size: inner.size, type: LinkType.Blob }]);
    const folder = await tree.putDirectory([{ name: 'Plans.irisdoc', cid: documentFolder.cid, size: 0, type: LinkType.Dir, meta: { modified_at: 1_700_000_000, kept: true } }]);
    const root = (await tree.putDirectory([{ name: 'Trip', cid: folder.cid, size: 0, type: LinkType.Dir }])).cid;

    const touched = await markFolderChanged(tree, root, ['Trip', 'Plans.irisdoc']);

    expect(await modified(tree, touched, ['Trip', 'Plans.irisdoc'])).toBeGreaterThan(1_700_000_000);
    const [entry] = await tree.listDirectory((await tree.resolvePath(touched, ['Trip']))!.cid);
    expect(entry.meta?.kept).toBe(true);
    expect(await tree.resolvePath(touched, ['Trip', 'Plans.irisdoc', 'a'])).not.toBeNull();
    // Nothing there, or a file there: nothing changes.
    expect(await markFolderChanged(tree, root, ['Trip', 'Gone'])).toEqual(root);
    expect(await markFolderChanged(tree, touched, ['Trip', 'Plans.irisdoc', 'a'])).toEqual(touched);
  });
});

async function readTombstones(tree: HashTree, root: CID): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const tombstones = await tree.resolvePath(root, ['.hashtree', 'tombstones']);
  if (!tombstones || tombstones.type !== LinkType.Dir) return out;
  const walk = async (directory: CID, prefix: string): Promise<void> => {
    for (const entry of await tree.listDirectory(directory)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === LinkType.Dir) await walk(entry.cid, path);
      else {
        const raw = await tree.readFile(entry.cid);
        out.set(path, Number(new TextDecoder().decode(raw ?? undefined)));
      }
    }
  };
  await walk(tombstones.cid, '');
  return out;
}
