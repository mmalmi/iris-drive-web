// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HashTree,
  LinkType,
  MemoryStore,
  toHex,
  type CID,
} from '@hashtree/core';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  buildDriveRootEvent,
  parseDriveRootEventForDevice,
  signNostrIdentityRosterOp,
} from '../src/drive/protocol';
import { mutateProfileDriveRoot } from '../src/drive/profileDriveMutation';
import { profileDriveProjection } from '../src/drive/profileDriveProjection';

const shared = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  secretKey: null as Uint8Array | null,
  tree: null as HashTree | null,
  registryRoot: null as null | { hash: Uint8Array; key?: Uint8Array; source?: string },
  adapter: null as null | { pushToBlossom: ReturnType<typeof vi.fn> },
  publish: vi.fn(async () => {}),
}));

vi.mock('../src/nostr', () => ({
  getCurrentNostrIdentitySession: () => shared.session,
  getSecretKey: () => shared.secretKey,
}));

vi.mock('../src/store', () => ({
  getTree: () => shared.tree,
}));

vi.mock('../src/workerAdapter', () => ({
  getWorkerAdapter: () => shared.adapter,
}));

vi.mock('../src/lib/nostrPublish', () => ({
  publishEvent: (event: unknown) => shared.publish(event),
}));

vi.mock('../src/TreeRootRegistry', () => ({ treeRootRegistry: { get: () => shared.registryRoot } }));
vi.mock('../src/stores/treeRoot', () => ({ getTreeRootSync: () => shared.registryRoot }));
vi.mock('../src/stores/treeRootResolver', () => ({ rebuildRetainedDriveRootProjection: () => {} }));

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

function activateProfile(): { secretKey: Uint8Array; appKeyPubkey: string } {
  const secretKey = generateSecretKey();
  const appKeyPubkey = getPublicKey(secretKey);
  const rosterOp = signNostrIdentityRosterOp({
    signerSecretKey: secretKey,
    profileId: PROFILE_ID,
    clientNonce: '89f3d04f-41fb-437b-9339-75df537bf292',
    createdAt: 100,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: appKeyPubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_secret_wraps: true,
          can_decrypt_secret_epochs: true,
        },
        added_at: 100,
      },
    },
  });
  shared.secretKey = secretKey;
  shared.session = {
    profileId: PROFILE_ID,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec: nip19.nsecEncode(secretKey),
    status: 'active',
    rosterOps: [rosterOp],
    createdAt: 100,
  };
  return { secretKey, appKeyPubkey };
}

async function rootWithFile(tree: HashTree, name: string, content: string): Promise<CID> {
  const file = await tree.putFile(new TextEncoder().encode(content));
  return (await tree.putDirectory([{
    name,
    cid: file.cid,
    size: file.size,
    type: LinkType.Blob,
  }])).cid;
}

describe('profile Drive root durability before publish', () => {
  beforeEach(() => {
    profileDriveProjection.clear();
    shared.session = null;
    shared.secretKey = null;
    shared.tree = null;
    shared.registryRoot = null;
    shared.adapter = null;
    shared.publish.mockReset();
    shared.publish.mockResolvedValue(undefined);
  });

  it('only publishes private Trash for an authorized owner key and keeps history keys out of its envelope', async () => {
    const { secretKey, appKeyPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    const root = (await tree.putDirectory([])).cid;
    shared.tree = tree;
    shared.adapter = { pushToBlossom: vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 })) };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');
    await expect(publishNostrIdentityDriveRootIfAvailable('trash', root, { rootScopeId: PROFILE_ID })).resolves.toBe(true);
    const event = shared.publish.mock.calls[0][0];
    expect(Object.keys(JSON.parse(event.content).root_key_wraps)).toEqual([appKeyPubkey]);
    expect(event.content).not.toContain(toHex(root.key!));
    expect(() => parseDriveRootEventForDevice(event, generateSecretKey())).toThrow();
    expect(() => buildDriveRootEvent({
      deviceSecretKey: secretKey, rootScopeId: PROFILE_ID, driveId: 'trash', root, dckGeneration: 0,
      parents: [{ root_cid: toHex(root.hash) + ':' + toHex(root.key!) }],
    })).toThrow('only a hash');
    shared.session!.rosterOps = [];
    await expect(publishNostrIdentityDriveRootIfAvailable('trash', root, { rootScopeId: PROFILE_ID })).resolves.toBe(false);
    expect(shared.publish).toHaveBeenCalledTimes(1);
  });

  it('uploads every exact root before announcing it', async () => {
    const order: string[] = [];
    const { appKeyPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    const root = await rootWithFile(tree, 'ordinary.txt', 'ordinary save');
    shared.tree = tree;
    const pushToBlossom = vi.fn(async () => {
      order.push('upload');
      return { pushed: 1, skipped: 0, failed: 0 };
    });
    shared.adapter = { pushToBlossom };
    shared.publish.mockImplementation(async () => {
      order.push('publish');
    });
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');

    await expect(publishNostrIdentityDriveRootIfAvailable('main', root, {
      appKeySeq: 1,
      publishedAt: 101,
    })).resolves.toBe(true);

    expect(order).toEqual(['upload', 'publish']);
    expect(shared.publish).toHaveBeenCalledTimes(1);
    const contribution = profileDriveProjection.contributionRoot(PROFILE_ID, 'main', appKeyPubkey)!;
    expect(pushToBlossom).toHaveBeenCalledWith(contribution.hash, contribution.key, 'main');
    expect(toHex(contribution.hash)).not.toBe(toHex(root.hash));
  });

  it('gives each version a later time than the one before, even within one second', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    shared.adapter = { pushToBlossom: vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 })) };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');

    // A relay keeps one version per device and decides by this time alone, so
    // two versions sharing a second would leave either of them standing.
    const sameSecond = Math.floor(Date.now() / 1000) + 50;
    await publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'one.txt', 'one'), { publishedAt: sameSecond });
    await publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'two.txt', 'two'), { publishedAt: sameSecond });
    await publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'three.txt', 'three'));

    const times = shared.publish.mock.calls.map(([event]) => (event as { created_at: number }).created_at);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(sameSecond);
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
  });

  it('publishes versions in the order they were made, even when a later one uploads faster', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const uploads: Array<() => void> = [];
    shared.adapter = {
      pushToBlossom: vi.fn(() => new Promise((resolve) => {
        uploads.push(() => resolve({ pushed: 1, skipped: 0, failed: 0 }));
      })),
    };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');
    const older = await rootWithFile(tree, 'added.txt', 'added');
    const newer = await rootWithFile(tree, 'renamed.txt', 'renamed');

    const first = publishNostrIdentityDriveRootIfAvailable('main', older);
    const second = publishNostrIdentityDriveRootIfAvailable('main', newer);
    // The newer version must not start its upload, let alone be announced, before the older one is out.
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    expect(shared.publish).not.toHaveBeenCalled();
    uploads[0]();
    await first;
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    uploads[1]();
    await second;

    const events = shared.publish.mock.calls.map(([event]) => event as { created_at: number; id: string });
    expect(events).toHaveLength(2);
    expect(events[1].created_at).toBeGreaterThan(events[0].created_at);
    expect(shared.adapter.pushToBlossom.mock.calls[0][0]).not.toEqual(shared.adapter.pushToBlossom.mock.calls[1][0]);
  });

  it('does not announce a prepared tombstone root when any block upload fails', async () => {
    const { secretKey, appKeyPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    const original = await rootWithFile(tree, 'removed.txt', 'remove me');
    const deleted = await mutateProfileDriveRoot(tree, original, {
      type: 'delete',
      path: 'removed.txt',
    }, { tombstonedAt: 100 });
    const previous = buildDriveRootEvent({
      deviceSecretKey: secretKey,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: deleted,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appKeyPubkey],
    });
    profileDriveProjection.add(previous, parseDriveRootEventForDevice(previous, secretKey));
    const visibleRoot = (await tree.putDirectory([])).cid;
    shared.tree = tree;
    const pushToBlossom = vi.fn(async () => ({
      pushed: 3,
      skipped: 0,
      failed: 1,
      errors: ['one block unavailable'],
    }));
    shared.adapter = { pushToBlossom };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');

    await expect(publishNostrIdentityDriveRootIfAvailable('main', visibleRoot, {
      appKeySeq: 2,
      publishedAt: 101,
    })).resolves.toBe(false);

    expect(pushToBlossom).toHaveBeenCalledTimes(1);
    const uploadedHash = pushToBlossom.mock.calls[0][0] as Uint8Array;
    expect(toHex(uploadedHash)).not.toBe(toHex(visibleRoot.hash));
    expect(shared.publish).not.toHaveBeenCalled();
    expect(profileDriveProjection.contributionRoot(PROFILE_ID, 'main', appKeyPubkey))
      .toEqual(deleted);
  });
  it('does not start an obsolete snapshot superseded while queued', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    shared.adapter = { pushToBlossom: vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 })) };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');
    await expect(publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'old.txt', 'old'), {
      onlyIfCurrent: () => false,
    })).resolves.toBe(false);
    expect(shared.adapter.pushToBlossom).not.toHaveBeenCalled();
    expect(shared.publish).not.toHaveBeenCalled();
  });

  it('does not announce a snapshot superseded during its upload', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    let current = true;
    shared.adapter = { pushToBlossom: vi.fn(async () => {
      current = false; // The other tab saved while these blocks were uploading.
      return { pushed: 1, skipped: 0, failed: 0 };
    }) };
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');
    await expect(publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'old.txt', 'old'), {
      onlyIfCurrent: () => current,
    })).resolves.toBe(false);
    expect(shared.adapter.pushToBlossom).toHaveBeenCalledTimes(1);
    expect(shared.publish).not.toHaveBeenCalled();
  });

  it('waits while another tab is publishing before uploading or assigning a version', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    shared.adapter = { pushToBlossom: vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 })) };
    let unlock!: () => void;
    const occupied = new Promise<void>(resolve => { unlock = resolve; });
    const request = vi.fn(async (_name: string, run: () => Promise<boolean>) => {
      await occupied;
      return run();
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const { publishNostrIdentityDriveRootIfAvailable } = await import('../src/drive/profileDriveRootPublish');
    const publishing = publishNostrIdentityDriveRootIfAvailable('main', await rootWithFile(tree, 'new.txt', 'new'));
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(shared.adapter.pushToBlossom).not.toHaveBeenCalled();
      expect(shared.publish).not.toHaveBeenCalled();
    } finally {
      unlock();
      await publishing;
      vi.unstubAllGlobals();
    }
    expect(shared.publish).toHaveBeenCalledTimes(1);
  });

  it('rewraps recovery keys when a metadata refresh replaces the same root object during upload', async () => {
    activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const root = await rootWithFile(tree, 'kept.txt', 'kept');
    shared.registryRoot = { ...root, source: 'nostr' };
    shared.adapter = { pushToBlossom: vi.fn(async () => {
      shared.registryRoot = { ...root, source: 'nostr' };
      return { pushed: 1, skipped: 0, failed: 0 };
    }) };
    const { publishNostrIdentityDriveRootIfAvailable, scheduleDriveRootRewrap } = await import('../src/drive/profileDriveRootPublish');
    await publishNostrIdentityDriveRootIfAvailable('main', root);
    expect(shared.publish).toHaveBeenCalledTimes(1);
    scheduleDriveRootRewrap(PROFILE_ID);
    await vi.waitFor(() => expect(shared.publish).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('retries recovery wrapping with the latest root after the queued root changes during upload', async () => {
    const { appKeyPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const before = await rootWithFile(tree, 'before.txt', 'before');
    const latest = await rootWithFile(tree, 'latest.txt', 'latest');
    shared.registryRoot = { ...before, source: 'nostr' };
    let uploads = 0;
    shared.adapter = { pushToBlossom: vi.fn(async () => {
      uploads += 1;
      if (uploads === 2) shared.registryRoot = { ...latest, source: 'nostr' };
      return { pushed: 1, skipped: 0, failed: 0 };
    }) };
    const { publishNostrIdentityDriveRootIfAvailable, scheduleDriveRootRewrap } = await import('../src/drive/profileDriveRootPublish');
    await publishNostrIdentityDriveRootIfAvailable('main', before);
    scheduleDriveRootRewrap(PROFILE_ID);
    await vi.waitFor(() => expect(shared.publish).toHaveBeenCalledTimes(2), { timeout: 4000 });
    const published = profileDriveProjection.contributionRoot(PROFILE_ID, 'main', appKeyPubkey)!;
    expect(await tree.resolvePath(published, ['latest.txt'])).not.toBeNull();
    expect(uploads).toBe(3);
  });

});
