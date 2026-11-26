import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID, type Store } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  deleteProfileDriveEntries,
  mutateProfileDriveRoot,
  prepareProfileDriveRootForPublish,
  setProfileDriveEntries,
} from '../src/drive/profileDriveMutation';
import { readPathKindReplacements, replacePathKindReplacements } from '../src/drive/profileDrivePathKindMetadata';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';
import { projectSharedFolderMemberRoster } from '../src/drive/protocolShareProjection';
import { createItemAccessLookup, itemAccess } from '../src/drive/itemAccess';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';
import { createZipFromDirectory, extractZip } from '../src/utils/compression';
import { appFacet, signedRosterOp, signedShareMemberOp } from './driveProtocolInterop.helpers';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';
const SHARE_ID = '22222222-2222-4222-8222-222222222222';

class MeteredStore implements Store {
  readonly inner = new MemoryStore();
  gets = 0;
  puts = 0;

  reset() {
    this.gets = 0;
    this.puts = 0;
  }

  put(hash: Uint8Array, data: Uint8Array) {
    this.puts += 1;
    return this.inner.put(hash, data);
  }

  get(hash: Uint8Array) {
    this.gets += 1;
    return this.inner.get(hash);
  }

  has(hash: Uint8Array) {
    return this.inner.has(hash);
  }

  delete(hash: Uint8Array) {
    return this.inner.delete(hash);
  }
}

async function seedDriveWithTombstones(
  store: MeteredStore,
  tree: HashTree,
  tombstoneCount: number,
  folderCount: number,
  filesPerFolder: number,
): Promise<{ root: CID; blob: { cid: CID; size: number } }> {
  const blob = await tree.putFile(new TextEncoder().encode('sample payload'));
  const trashDir = await tree.putDirectory(Array.from({ length: tombstoneCount }, (_, i) => ({
    name: `old-${String(i).padStart(3, '0')}.txt`,
    cid: blob.cid,
    size: blob.size,
    type: LinkType.Blob,
  })));
  const dirs = [{ name: 'Archive', cid: trashDir.cid, size: 0, type: LinkType.Dir }];
  for (let f = 0; f < folderCount; f += 1) {
    const dir = await tree.putDirectory(Array.from({ length: filesPerFolder }, (_, i) => ({
      name: `file-${String(i).padStart(2, '0')}.txt`,
      cid: blob.cid,
      size: blob.size,
      type: LinkType.Blob,
    })));
    dirs.push({ name: `Folder-${String(f).padStart(2, '0')}`, cid: dir.cid, size: 0, type: LinkType.Dir });
  }
  let root = (await tree.putDirectory(dirs)).cid;
  root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: 'Archive' }, { tombstonedAt: 1000 });
  root = await prepareProfileDriveRootForPublish(tree, root);
  store.reset();
  return { root, blob };
}

describe('performance and scaling regressions', () => {
  it('keeps unrelated writes and publish preparation O(1) regardless of historical tombstone count', async () => {
    const store = new MeteredStore();
    const tree = new HashTree({ store });
    const { root: baseRoot, blob } = await seedDriveWithTombstones(store, tree, 100, 4, 5);

    const edited = await mutateProfileDriveRoot(tree, baseRoot, {
      type: 'set-entry',
      path: 'Folder-00/fresh.txt',
      entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
    });
    expect(store.gets).toBeLessThanOrEqual(10);
    expect(store.puts).toBeLessThanOrEqual(4);

    store.reset();
    const published = await prepareProfileDriveRootForPublish(tree, edited, baseRoot);
    expect(store.gets).toBeLessThanOrEqual(10);
    expect(store.puts).toBe(0);
    expect(await tree.resolvePath(published, ['Folder-00', 'fresh.txt'])).not.toBeNull();
  });

  it('still clears descendant path-kind replacement roles when an ancestor path is cleared', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const blob = await tree.putFile(new TextEncoder().encode('hello'));
    let root = (await tree.putDirectory([])).cid;
    root = await replacePathKindReplacements(tree, root, new Map([['Folder/sub', 5]]));

    const updated = await mutateProfileDriveRoot(tree, root, {
      type: 'set-entry',
      path: 'Folder',
      entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
    });
    const prepared = await prepareProfileDriveRootForPublish(tree, updated, root);
    const { roles } = await readPathKindReplacements(tree, prepared);
    expect(roles.size).toBe(0);
  });

  it('batches multi-file deletes and nested writes without per-file tree or tombstone rewrites', async () => {
    const store = new MeteredStore();
    const tree = new HashTree({ store });
    const { root: baseRoot, blob } = await seedDriveWithTombstones(store, tree, 80, 1, 30);

    const names = Array.from({ length: 25 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
    const deleted = await deleteProfileDriveEntries(tree, baseRoot, ['Folder-00'], names, { tombstonedAt: 2000 });
    expect(store.puts).toBeLessThanOrEqual(12);
    expect(store.gets).toBeLessThanOrEqual(20);
    expect((await tree.listDirectory((await tree.resolvePath(deleted, ['Folder-00']))!.cid)).map((e) => e.name).sort())
      .toEqual(['file-25.txt', 'file-26.txt', 'file-27.txt', 'file-28.txt', 'file-29.txt']);

    store.reset();
    const writes = Array.from({ length: 20 }, (_, i) => ({
      path: [`Batch-${i % 5}`, `item-${i}.txt`],
      entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
    }));
    const batched = await setProfileDriveEntries(tree, baseRoot, writes);
    expect(store.puts).toBeLessThanOrEqual(10);

    let sequential = baseRoot;
    for (const write of writes) {
      sequential = await mutateProfileDriveRoot(tree, sequential, {
        type: 'set-entry',
        path: write.path.join('/'),
        entry: write.entry,
      });
    }
    expect(toHex(batched.hash)).toBe(toHex(sequential.hash));
  });

  it('ignores stale .name properties on TreeEntry writes and splits slash-separated paths', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const blob = await tree.putFile(new TextEncoder().encode('original'));
    const initial = await mutateProfileDriveRoot(tree, (await tree.putDirectory([])).cid, {
      type: 'set-entry',
      path: 'Notes/meeting.txt',
      entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
    });
    const existing = (await tree.listDirectory((await tree.resolvePath(initial, ['Notes']))!.cid))[0]!;
    expect(existing.name).toBe('meeting.txt');

    // Passing a full TreeEntry (with runtime `.name = 'meeting.txt'`) under a new name must not duplicate `meeting.txt`.
    const restored = await setProfileDriveEntries(tree, initial, [{
      path: ['Notes', 'meeting (2).txt'],
      entry: existing,
    }]);
    const names = (await tree.listDirectory((await tree.resolvePath(restored, ['Notes']))!.cid))
      .map((e) => e.name)
      .sort();
    expect(names).toEqual(['meeting (2).txt', 'meeting.txt']);

    // Slash-separated entry paths passed as a single element must create nested folders, not a literal slash filename.
    const nested = await setProfileDriveEntries(tree, restored, [{
      path: ['kind-folder/old.txt'],
      entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
    }]);
    expect((await tree.resolvePath(nested, ['kind-folder']))?.type).toBe(LinkType.Dir);
    expect((await tree.resolvePath(nested, ['kind-folder', 'old.txt']))?.type).toBe(LinkType.Blob);
  });

  it('passes through unchanged directories and reuses cached subtree walks on materialize', async () => {
    const store = new MeteredStore();
    const tree = new HashTree({ store });
    const { root: rootA, blob } = await seedDriveWithTombstones(store, tree, 100, 20, 5);
    const rootB = await prepareProfileDriveRootForPublish(
      tree,
      await mutateProfileDriveRoot(tree, rootA, {
        type: 'set-entry',
        path: 'Folder-01/from-b.txt',
        entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
      }),
      rootA,
    );

    const reader = generateSecretKey();
    const devA = generateSecretKey();
    const devB = generateSecretKey();
    const pkA = getPublicKey(devA);
    const pkB = getPublicKey(devB);
    const authorized = new Set([pkA, pkB]);

    const evA1 = buildDriveRootEvent({
      deviceSecretKey: devA, rootScopeId: PROFILE_ID, driveId: 'main', root: rootA,
      dckGeneration: 1, appKeySeq: 1, publishedAt: 100, authorizedAppKeyPubkeys: [getPublicKey(reader)],
    });
    const evB1 = buildDriveRootEvent({
      deviceSecretKey: devB, rootScopeId: PROFILE_ID, driveId: 'main', root: rootB,
      dckGeneration: 1, appKeySeq: 1, publishedAt: 101, authorizedAppKeyPubkeys: [getPublicKey(reader)],
      observed: { [pkA]: { app_key_seq: 1, root_cid: toHex(rootA.hash) } },
    });

    const projection = new ProfileDriveProjection();
    projection.add(evA1, parseDriveRootEventForDevice(evA1, reader));
    projection.add(evB1, parseDriveRootEventForDevice(evB1, reader));

    store.reset();
    const cold = await projection.materialize(tree, PROFILE_ID, 'main', authorized);
    expect(cold).not.toBeNull();
    // 19 untouched folders pass through; only root + Folder-01 are rewritten.
    expect(store.puts).toBeLessThanOrEqual(4);

    // One edit on devA: warm re-materialize reuses cached untouched subtrees.
    const rootA2 = await prepareProfileDriveRootForPublish(
      tree,
      await mutateProfileDriveRoot(tree, cold!.root, {
        type: 'set-entry',
        path: 'Folder-00/from-a.txt',
        entry: { cid: blob.cid, size: blob.size, type: LinkType.Blob },
      }),
      rootA,
    );
    const evA2 = buildDriveRootEvent({
      deviceSecretKey: devA, rootScopeId: PROFILE_ID, driveId: 'main', root: rootA2,
      dckGeneration: 1, appKeySeq: 2, publishedAt: 102, authorizedAppKeyPubkeys: [getPublicKey(reader)],
      observed: { [pkB]: { app_key_seq: 1, root_cid: toHex(rootB.hash) } },
    });
    projection.add(evA2, parseDriveRootEventForDevice(evA2, reader));

    store.reset();
    const warm = await projection.materialize(tree, PROFILE_ID, 'main', authorized);
    expect(store.gets).toBeLessThanOrEqual(15);
    expect(store.puts).toBeLessThanOrEqual(4);

    // Verify cached warm output matches a brand-new uncached HashTree instance byte-for-byte.
    const freshTree = new HashTree({ store: store.inner });
    const uncached = await projection.materialize(freshTree, PROFILE_ID, 'main', authorized);
    expect(toHex(warm!.root.hash)).toBe(toHex(uncached!.root.hash));

    // Single-root materialize only strips `.hashtree` without rewriting any folder.
    const single = new ProfileDriveProjection();
    single.add(evA2, parseDriveRootEventForDevice(evA2, reader));
    store.reset();
    const singleMat = await single.materialize(tree, PROFILE_ID, 'main', new Set([pkA]));
    expect(store.puts).toBe(1);
    expect(await tree.resolvePath(singleMat!.root, ['.hashtree'])).toBeNull();
    expect(await tree.resolvePath(singleMat!.root, ['Folder-00', 'from-a.txt'])).not.toBeNull();
  });

  it('caches shared-folder member projections safely without mutating or skipping tampered ops', () => {
    const ownerSk = generateSecretKey();
    const ownerPk = getPublicKey(ownerSk);
    const memberPk = getPublicKey(generateSecretKey());
    const memberProfile = '33333333-3333-4333-8333-333333333333';

    const op0 = signedRosterOp(ownerSk, SHARE_ID, 10, {
      op: 'add_facet', facet: appFacet(ownerPk, 10, 'Owner', true, true, PROFILE_ID),
    });
    const op1 = signedRosterOp(ownerSk, SHARE_ID, 11, {
      op: 'add_facet', facet: appFacet(memberPk, 11, 'Member', true, false, memberProfile),
    }, [op0.op_id]);
    const m0 = signedShareMemberOp(ownerSk, SHARE_ID, 10, {
      op: 'grant_member', member: { profile_id: PROFILE_ID, role: 'admin', status: 'active' },
    }, [], [op0.op_id]);
    const m1 = signedShareMemberOp(ownerSk, SHARE_ID, 11, {
      op: 'grant_member', member: { profile_id: memberProfile, role: 'editor', status: 'active' },
    }, [m0.op_id], [op1.op_id]);

    const folder = {
      share_id: SHARE_ID,
      owner_profile_id: PROFILE_ID,
      display_name: 'Team',
      source_path: 'Team',
      roster_ops: [op0, op1],
      member_ops: [m0, m1],
    } as AcceptedShareRecord['folder'];

    const first = projectSharedFolderMemberRoster(folder);
    first.members[memberProfile]!.role = 'viewer';
    const second = projectSharedFolderMemberRoster(folder);
    expect(second.members[memberProfile]?.role).toBe('editor');

    const badEvent = { ...JSON.parse(m1.event_json), sig: '0'.repeat(128) };
    const tampered = {
      ...folder,
      member_ops: [m0, { ...m1, event_json: JSON.stringify(badEvent) }],
    } as AcceptedShareRecord['folder'];
    const tamperedResult = projectSharedFolderMemberRoster(tampered);
    expect(tamperedResult.members[memberProfile]).toBeUndefined();
    expect(tamperedResult.rejected_op_ids).toContain(m1.op_id);

    const record: AcceptedShareRecord = {
      share_id: SHARE_ID, local_profile_id: PROFILE_ID, accepted_at: 10, invite_payload: '', shortcuts: [], folder,
    };
    const lookup = createItemAccessLookup({
      scope: SHARE_ID, treeName: 'main', profileId: PROFILE_ID, appKeyPubkey: ownerPk, records: [record],
    });
    const direct = itemAccess({
      scope: SHARE_ID, treeName: 'main', path: ['doc.txt'], profileId: PROFILE_ID, appKeyPubkey: ownerPk, records: [record],
    });
    expect(lookup(['doc.txt'])).toEqual(direct);
    expect(direct).toEqual({ kind: 'people', people: 1 });
  });

  it('stores precompressed media without re-deflating in ZIP exports while deflating text', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const jpgBytes = new Uint8Array(8192);
    crypto.getRandomValues(jpgBytes);
    const txtBytes = new TextEncoder().encode('compressible text line\n'.repeat(200));

    const jpg = await tree.putFile(jpgBytes);
    const txt = await tree.putFile(txtBytes);
    const dir = await tree.putDirectory([
      { name: 'photo.jpg', cid: jpg.cid, size: jpg.size, type: LinkType.Blob },
      { name: 'notes.txt', cid: txt.cid, size: txt.size, type: LinkType.Blob },
    ]);

    const zipBytes = await createZipFromDirectory(tree, dir.cid, 'Bundle');
    const extracted = extractZip(zipBytes);
    expect(extracted['photo.jpg']).toEqual(jpgBytes);
    expect(extracted['notes.txt']).toEqual(txtBytes);

    // Parse local file headers (PK\x03\x04) to verify compression methods: 0=store, 8=deflate.
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const methods = new Map<string, number>();
    for (let i = 0; i < zipBytes.length - 30; i += 1) {
      if (view.getUint32(i, true) !== 0x04034b50) continue;
      const method = view.getUint16(i + 8, true);
      const nameLen = view.getUint16(i + 26, true);
      const name = new TextDecoder().decode(zipBytes.subarray(i + 30, i + 30 + nameLen));
      methods.set(name, method);
    }
    expect(methods.get('photo.jpg')).toBe(0);
    expect(methods.get('notes.txt')).toBe(8);
  });
});
