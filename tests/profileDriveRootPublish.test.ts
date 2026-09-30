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
    shared.adapter = null;
    shared.publish.mockReset();
    shared.publish.mockResolvedValue(undefined);
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
});
