import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { mutateProfileDriveRoot } from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('legacy profile Drive path-kind conflicts', () => {
  it('preserves suppressed directory children when seq=0 roots lack causal references', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const directoryWriter = generateSecretKey();
    const fileWriter = generateSecretKey();
    const directoryPubkey = getPublicKey(directoryWriter);
    const filePubkey = getPublicKey(fileWriter);
    let directoryRoot = (await tree.putDirectory([])).cid;
    directoryRoot = await mutateProfileDriveRoot(
      tree,
      directoryRoot,
      { type: 'write', path: 'draft/child.txt', content: 'legacy child' },
      { recordTombstones: false },
    );
    const fileRoot = await mutateProfileDriveRoot(
      tree,
      directoryRoot,
      { type: 'write', path: 'draft', content: 'legacy replacement' },
      { tombstonedAt: 200 },
    );
    const directoryEvent = legacyRoot(directoryWriter, getPublicKey(reader), directoryRoot, 100);
    const fileEvent = legacyRoot(fileWriter, getPublicKey(reader), fileRoot, 999);
    const projection = new ProfileDriveProjection();
    projection.add(directoryEvent, parseDriveRootEventForDevice(directoryEvent, reader));
    projection.add(fileEvent, parseDriveRootEventForDevice(fileEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([directoryPubkey, filePubkey]),
    );
    expect((await tree.resolvePath(result!.root, ['draft']))?.type).toBe(LinkType.Dir);
    const child = await tree.resolvePath(result!.root, ['draft', 'child.txt']);
    expect(new TextDecoder().decode(await tree.readFile(child!.cid) ?? undefined))
      .toBe('legacy child');
    const conflict = await tree.resolvePath(
      result!.root,
      [`draft (conflict from ${filePubkey})`],
    );
    expect(new TextDecoder().decode(await tree.readFile(conflict!.cid) ?? undefined))
      .toBe('legacy replacement');
  });
});

function legacyRoot(
  signer: Uint8Array,
  readerPubkey: string,
  root: CID,
  publishedAt: number,
) {
  return buildDriveRootEvent({
    deviceSecretKey: signer,
    rootScopeId: PROFILE_ID,
    driveId: 'main',
    root,
    dckGeneration: 1,
    appKeySeq: 0,
    publishedAt,
    authorizedAppKeyPubkeys: [readerPubkey],
  });
}
