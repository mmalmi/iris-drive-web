import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';
import { prepareProfileDriveRootForPublish } from '../src/drive/profileDriveMutation';
import { readPathKindReplacements } from '../src/drive/profileDrivePathKindMetadata';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174170';
const APP_KEY = 'a'.repeat(64);
const shared = vi.hoisted(() => ({
  tree: null as HashTree | null,
  root: null as CID | null,
  savedRoot: null as CID | null,
  routeScope: '123e4567-e89b-42d3-a456-426614174170',
  state: {
    isLoggedIn: true,
    pubkey: 'a'.repeat(64),
    npub: 'npub1appkey',
    selectedTree: null,
  },
}));

vi.mock('../src/nostr/auth', () => ({
  getCurrentNostrIdentitySession: () => ({
    status: 'active',
    profileId: PROFILE_ID,
    appKeyPubkey: APP_KEY,
  }),
}));

vi.mock('../src/store', () => ({
  getTree: () => shared.tree,
  localStore: {},
}));

vi.mock('../src/nostr', () => ({
  autosaveIfOwn: (root: CID) => {
    shared.root = root;
    shared.savedRoot = root;
  },
  linkKeyUtils: {},
  saveHashtree: vi.fn(),
  nostrStore: {
    getState: () => shared.state,
    setSelectedTree: vi.fn(),
  },
  useNostrStore: {
    getState: () => shared.state,
    setSelectedTree: vi.fn(),
  },
}));

vi.mock('../src/utils/route', () => ({
  isNostrIdentityId: (value: string) => value === '123e4567-e89b-42d3-a456-426614174170',
  parseRoute: () => ({
    npub: shared.routeScope,
    treeName: 'main',
    path: [],
    params: new URLSearchParams(),
  }),
}));

vi.mock('../src/actions/route', () => ({
  getCurrentRootCid: () => shared.root,
  getCurrentPathFromUrl: () => [],
  updateRoute: vi.fn(),
  buildRouteUrl: vi.fn(),
}));

vi.mock('../src/stores/upload', () => ({ setUploadProgress: vi.fn() }));
vi.mock('../src/stores/recentlyChanged', () => ({ markFilesChanged: vi.fn() }));
vi.mock('../src/treeRootCache', () => ({
  getLocalRootCache: vi.fn(),
  updateLocalRootCache: vi.fn(),
}));
vi.mock('../src/utils/navigate', () => ({ navigate: vi.fn() }));
vi.mock('../src/stores/trees', () => ({ storeLinkKey: vi.fn() }));

import { createFile } from '../src/actions/file';
import { createFolder } from '../src/actions/tree';

describe('profile Drive UI actions', () => {
  beforeEach(() => {
    shared.tree = new HashTree({ store: new MemoryStore() });
    shared.root = null;
    shared.savedRoot = null;
    shared.routeScope = PROFILE_ID;
  });

  it('does not publish a delayed private file into a newly selected public route', async () => {
    const tree = shared.tree!;
    shared.root = (await tree.putDirectory([])).cid;
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
    const save = createFile('private.txt', 'private document contents');
    await writing;
    shared.routeScope = 'npub1publicowner';
    resume();
    await save;
    expect(shared.savedRoot).toBeNull();
  });

  it('creates a file over a folder through the durable route mutation', async () => {
    const tree = shared.tree!;
    const child = await tree.putFile(new TextEncoder().encode('old child'));
    const directory = await tree.putDirectory([{
      name: 'child.txt',
      cid: child.cid,
      size: child.size,
      type: LinkType.Blob,
    }]);
    shared.root = (await tree.putDirectory([{
      name: 'draft',
      cid: directory.cid,
      size: 0,
      type: LinkType.Dir,
    }])).cid;

    await createFile('draft', 'replacement');
    const prepared = await prepareProfileDriveRootForPublish(tree, shared.savedRoot!);

    const roles = (await readPathKindReplacements(tree, prepared)).roles;
    expect(roles.has('draft')).toBe(true);
    expect((await tree.resolvePath(prepared, ['draft']))?.type).toBe(LinkType.Blob);
  });

  it('creates a folder over a file through the durable route mutation', async () => {
    const tree = shared.tree!;
    const file = await tree.putFile(new TextEncoder().encode('old file'));
    shared.root = (await tree.putDirectory([{
      name: 'draft',
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    }])).cid;

    await createFolder('draft');
    const prepared = await prepareProfileDriveRootForPublish(tree, shared.savedRoot!);

    const roles = (await readPathKindReplacements(tree, prepared)).roles;
    expect(roles.has('draft')).toBe(true);
    expect((await tree.resolvePath(prepared, ['draft']))?.type).toBe(LinkType.Dir);
  });
});
