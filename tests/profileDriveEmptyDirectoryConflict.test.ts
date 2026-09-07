import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { mutateProfileDriveRoot } from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('profile Drive empty-directory kind conflicts', () => {
  it('preserves only still-visible empty directories during a later kind replacement', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const replacementPubkey = getPublicKey(replacementWriter);
    let originalRoot = (await tree.putDirectory([])).cid;
    for (const path of ['draft', 'draft/deleted-empty', 'draft/keep-empty']) {
      originalRoot = await mutateProfileDriveRoot(
        tree,
        originalRoot,
        { type: 'mkdir', path },
        { recordTombstones: false },
      );
    }
    const afterChildDelete = await mutateProfileDriveRoot(
      tree,
      originalRoot,
      { type: 'delete', path: 'draft/deleted-empty' },
      { tombstonedAt: 100 },
    );
    const replacementRoot = await mutateProfileDriveRoot(
      tree,
      afterChildDelete,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 200 },
    );
    const originalEvent = driveRoot(
      originalWriter,
      getPublicKey(reader),
      originalRoot,
      1,
      50,
    );
    const replacementEvent = driveRoot(
      replacementWriter,
      getPublicKey(reader),
      replacementRoot,
      2,
      999,
      { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(originalRoot.hash) } },
    );
    const projection = new ProfileDriveProjection();
    projection.add(originalEvent, parseDriveRootEventForDevice(originalEvent, reader));
    projection.add(replacementEvent, parseDriveRootEventForDevice(replacementEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([originalPubkey, replacementPubkey]),
    );
    const conflictDirectory = `draft (conflict from ${originalPubkey})`;
    expect((await tree.resolvePath(result!.root, [conflictDirectory, 'keep-empty']))?.type)
      .toBe(LinkType.Dir);
    expect(await tree.resolvePath(result!.root, [conflictDirectory, 'deleted-empty']))
      .toBeNull();
  });
});

function driveRoot(
  signer: Uint8Array,
  readerPubkey: string,
  root: CID,
  sequence: number,
  publishedAt: number,
  observed: Record<string, { app_key_seq: number; root_cid: string }> = {},
) {
  return buildDriveRootEvent({
    deviceSecretKey: signer,
    rootScopeId: PROFILE_ID,
    driveId: 'main',
    root,
    dckGeneration: 1,
    appKeySeq: sequence,
    publishedAt,
    authorizedAppKeyPubkeys: [readerPubkey],
    observed,
  });
}
