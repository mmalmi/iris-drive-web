import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { mutateProfileDriveRoot } from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('multi-version profile Drive path-kind conflicts', () => {
  it('preserves every concurrent child version when a directory is replaced by a file', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const writerA = generateSecretKey();
    const writerB = generateSecretKey();
    const replacer = generateSecretKey();
    const pubkeyA = getPublicKey(writerA);
    const pubkeyB = getPublicKey(writerB);
    const replacerPubkey = getPublicKey(replacer);
    const rootA = await directoryRoot(tree, 'version A');
    const rootB = await directoryRoot(tree, 'version B');
    const replacementRoot = await mutateProfileDriveRoot(
      tree,
      rootA,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 200 },
    );
    const readerPubkey = getPublicKey(reader);
    const eventA = driveRoot(writerA, readerPubkey, rootA, 100);
    const eventB = driveRoot(writerB, readerPubkey, rootB, 101);
    const replacementEvent = driveRoot(replacer, readerPubkey, replacementRoot, 999, {
      [pubkeyA]: { app_key_seq: 1, root_cid: toHex(rootA.hash) },
      [pubkeyB]: { app_key_seq: 1, root_cid: toHex(rootB.hash) },
    });
    const projection = new ProfileDriveProjection();
    for (const event of [eventA, eventB, replacementEvent]) {
      projection.add(event, parseDriveRootEventForDevice(event, reader));
    }

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([pubkeyA, pubkeyB, replacerPubkey]),
    );
    expect((await tree.resolvePath(result!.root, ['draft']))?.type).toBe(LinkType.Blob);
    const conflictRootName = (await tree.listDirectory(result!.root))
      .map((entry) => entry.name)
      .find((name) => name.startsWith('draft (conflict from '));
    expect(conflictRootName).toBeDefined();
    const conflictRoot = await tree.resolvePath(result!.root, [conflictRootName!]);
    const contents = await Promise.all((await tree.listDirectory(conflictRoot!.cid))
      .filter((entry) => entry.type === LinkType.Blob)
      .map(async (entry) => new TextDecoder().decode(await tree.readFile(entry.cid) ?? undefined)));
    expect(contents.sort()).toEqual(['version A', 'version B']);
  });
});

async function directoryRoot(tree: HashTree, content: string): Promise<CID> {
  const root = (await tree.putDirectory([])).cid;
  return mutateProfileDriveRoot(
    tree,
    root,
    { type: 'write', path: 'draft/note.txt', content },
    { recordTombstones: false },
  );
}

function driveRoot(
  signer: Uint8Array,
  readerPubkey: string,
  root: CID,
  publishedAt: number,
  observed: Record<string, { app_key_seq: number; root_cid: string }> = {},
) {
  return buildDriveRootEvent({
    deviceSecretKey: signer,
    rootScopeId: PROFILE_ID,
    driveId: 'main',
    root,
    dckGeneration: 1,
    appKeySeq: 1,
    publishedAt,
    authorizedAppKeyPubkeys: [readerPubkey],
    observed,
  });
}
