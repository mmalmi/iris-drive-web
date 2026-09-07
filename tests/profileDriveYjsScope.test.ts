import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174170';
const APP_KEY = 'a'.repeat(64);
const APP_NPUB = 'npub1activeappkey';
const shared = vi.hoisted(() => ({
  tree: null as HashTree | null,
  roots: new Map<string, CID>(),
  rootLookups: [] as string[],
  savedRoot: null as CID | null,
  cacheWrites: [] as string[],
  route: { npub: '123e4567-e89b-42d3-a456-426614174170', treeName: 'main', path: ['doc'] },
  state: { isLoggedIn: true, pubkey: 'a'.repeat(64) },
  visibility: 'private',
  profileId: '123e4567-e89b-42d3-a456-426614174170',
}));

vi.mock('../src/nostr/auth', () => ({
  getCurrentNostrIdentitySession: () => ({
    status: 'active',
    profileId: shared.profileId,
    appKeyPubkey: 'a'.repeat(64),
  }),
}));

vi.mock('../src/store', () => ({ getTree: () => shared.tree }));
vi.mock('../src/stores', () => ({
  getTreeRootSync: (scope: string, treeName: string) => {
    const key = `${scope}/${treeName}`;
    shared.rootLookups.push(key);
    return shared.roots.get(key) ?? null;
  },
}));
vi.mock('../src/nostr', () => ({
  autosaveIfOwn: (root: CID) => { shared.savedRoot = root; },
  nostrStore: {
    getState: () => ({ ...shared.state, selectedTree: { name: 'main', visibility: shared.visibility } }),
  },
}));
vi.mock('../src/utils/route', () => ({
  parseRoute: () => shared.route,
  isNostrIdentityId: (value: string) => /^[0-9a-f]{8}-/.test(value),
}));
vi.mock('../src/treeRootCache', () => ({
  updateLocalRootCacheHex: (scope: string, treeName: string) => {
    shared.cacheWrites.push(`${scope}/${treeName}`);
  },
}));
vi.mock('../src/refResolver', () => ({ getRefResolver: vi.fn() }));

import { resolveYjsRouteScopes } from '../src/lib/yjs/routeScope';
import { parseAttachmentReference, saveImageToTree } from '../src/lib/yjs/imageAttachments';

const STATE = { isLoggedIn: true, pubkey: APP_KEY };

describe('profile Drive Yjs route scope', () => {
  beforeEach(() => {
    shared.tree = new HashTree({ store: new MemoryStore() });
    shared.roots.clear();
    shared.rootLookups.length = 0;
    shared.savedRoot = null;
    shared.cacheWrites.length = 0;
    shared.route = { npub: PROFILE_ID, treeName: 'main', path: ['doc'] };
    shared.state = { isLoggedIn: true, pubkey: APP_KEY };
    shared.visibility = 'private';
    shared.profileId = PROFILE_ID;
  });

  it('uses the active profile UUID for storage while keeping the AppKey npub as collaborator identity', () => {
    expect(resolveYjsRouteScopes(PROFILE_ID, APP_NPUB, STATE)).toEqual({
      isOwnTree: true,
      ownerNpub: APP_NPUB,
      viewedRootScope: PROFILE_ID,
      writeRootScope: PROFILE_ID,
    });
  });

  it('preserves deliberate collaborator writes to the local editor npub tree', () => {
    const remoteOwner = 'npub1remoteowner';
    expect(resolveYjsRouteScopes(remoteOwner, APP_NPUB, STATE)).toEqual({
      isOwnTree: false,
      ownerNpub: remoteOwner,
      viewedRootScope: remoteOwner,
      writeRootScope: APP_NPUB,
    });
  });

  it('loads and saves an attachment through the active UUID root', async () => {
    const tree = shared.tree!;
    const doc = await tree.putDirectory([]);
    const original = (await tree.putDirectory([{
      name: 'doc',
      cid: doc.cid,
      size: 0,
      type: LinkType.Dir,
    }])).cid;
    shared.roots.set(`${PROFILE_ID}/main`, original);

    await expect(saveImageToTree(
      new Uint8Array([1, 2, 3]),
      'photo.png',
      ['doc'],
      PROFILE_ID,
      'main',
      true,
    )).resolves.toBe('photo.png');

    expect(shared.rootLookups).toEqual([`${PROFILE_ID}/main`]);
    expect(shared.savedRoot).not.toBeNull();
    expect(await tree.resolvePath(shared.savedRoot!, ['doc', 'attachments', 'photo.png']))
      .not.toBeNull();
    expect(shared.cacheWrites).toEqual([]);
  });

  it.each(['route', 'identity', 'session', 'visibility'])('does not publish a private attachment after its %s changes', async (change) => {
    const tree = shared.tree!;
    const empty = (await tree.putDirectory([])).cid;
    const doc = await tree.setEntry(empty, [], 'attachments', empty, 0, LinkType.Dir);
    const original = await tree.setEntry(empty, [], 'doc', doc, 0, LinkType.Dir);
    shared.roots.set(`${PROFILE_ID}/main`, original);
    const setEntry = vi.spyOn(tree, 'setEntry');
    const putFile = tree.putFile.bind(tree);
    let resume!: () => void;
    let started!: () => void;
    const suspended = new Promise<void>((resolve) => { resume = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(tree, 'putFile').mockImplementationOnce(async (...args) => {
      started();
      await suspended;
      return putFile(...args);
    });
    const save = saveImageToTree(new Uint8Array([1, 2, 3]), 'private.png', ['doc'], PROFILE_ID, 'main', true);
    await writing;
    if (change === 'route') shared.route = { npub: 'npub1publicowner', treeName: 'public', path: [] };
    else if (change === 'identity') shared.state = { isLoggedIn: true, pubkey: 'b'.repeat(64) };
    else if (change === 'session') shared.profileId = '123e4567-e89b-42d3-a456-426614174171';
    else shared.visibility = 'public';
    resume();

    await expect(save).resolves.toBeNull();
    expect(shared.savedRoot).toBeNull();
    expect(shared.cacheWrites).toEqual([]);
    expect(setEntry).not.toHaveBeenCalled();
  });

  it('round-trips UUID-scoped attachment references and keeps legacy defaults', () => {
    expect(parseAttachmentReference(`${PROFILE_ID}/photo.png`, APP_NPUB)).toEqual({
      rootScope: PROFILE_ID,
      filename: 'photo.png',
    });
    expect(parseAttachmentReference('legacy.png', PROFILE_ID)).toEqual({
      rootScope: PROFILE_ID,
      filename: 'legacy.png',
    });
  });
});
