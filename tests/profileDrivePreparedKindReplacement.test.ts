import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  mutateProfileDriveRoot,
  prepareProfileDriveRootForPublishResult,
} from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('prepared profile Drive kind replacements', () => {
  it('rebases metadata-free mutation markers above retained tombstones', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const replacementPubkey = getPublicKey(replacementWriter);
    const originalRoot = await rootWithFiles(tree, {
      'draft/deleted.txt': 'must stay deleted',
      'draft/keep.txt': 'must survive',
    });
    const previousContribution = await mutateProfileDriveRoot(
      tree,
      originalRoot,
      { type: 'delete', path: 'draft/deleted.txt' },
      { tombstonedAt: 100 },
    );
    const metadataFreeVisible = await rootWithFiles(tree, {
      'draft/keep.txt': 'must survive',
    });
    const dirtyReplacement = await mutateProfileDriveRoot(
      tree,
      metadataFreeVisible,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 100 },
    );
    const prepared = await prepareProfileDriveRootForPublishResult(
      tree,
      dirtyReplacement,
      previousContribution,
    );
    const result = await projectPair(
      tree,
      reader,
      originalWriter,
      originalRoot,
      replacementWriter,
      prepared.root,
    );

    const conflictDirectory = `draft (conflict from ${originalPubkey})`;
    const kept = await tree.resolvePath(result, [conflictDirectory, 'keep.txt']);
    expect(new TextDecoder().decode(await tree.readFile(kept!.cid) ?? undefined))
      .toBe('must survive');
    expect(await tree.resolvePath(result, [conflictDirectory, 'deleted.txt']))
      .toBeNull();
    expect((await tree.resolvePath(result, ['draft']))?.type).toBe(LinkType.Blob);
    expect(replacementPubkey).not.toBe(originalPubkey);
  });

  it('marks replacement of a logically empty directory as the current generation', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const originalRoot = await rootWithFiles(tree, {
      'draft/deleted.txt': 'must stay deleted',
    });
    const previousContribution = await mutateProfileDriveRoot(
      tree,
      originalRoot,
      { type: 'delete', path: 'draft/deleted.txt' },
      { tombstonedAt: 100 },
    );
    let metadataFreeVisible = (await tree.putDirectory([])).cid;
    metadataFreeVisible = await mutateProfileDriveRoot(
      tree,
      metadataFreeVisible,
      { type: 'mkdir', path: 'draft' },
      { recordTombstones: false },
    );
    const dirtyReplacement = await mutateProfileDriveRoot(
      tree,
      metadataFreeVisible,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 100 },
    );
    const prepared = await prepareProfileDriveRootForPublishResult(
      tree,
      dirtyReplacement,
      previousContribution,
    );
    const result = await projectPair(
      tree,
      reader,
      originalWriter,
      originalRoot,
      replacementWriter,
      prepared.root,
    );

    expect((await tree.resolvePath(result, ['draft']))?.type).toBe(LinkType.Blob);
    const conflictDirectory = `draft (conflict from ${originalPubkey})`;
    expect((await tree.resolvePath(result, [conflictDirectory]))?.type).toBe(LinkType.Dir);
    expect(await tree.resolvePath(result, [conflictDirectory, 'deleted.txt']))
      .toBeNull();
  });

  it('clears stale descendant markers when a deleted replacement is recreated', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const originalRoot = await rootWithFiles(tree, {
      'draft/old.txt': 'must not return',
    });
    const replacement = await mutateProfileDriveRoot(
      tree,
      originalRoot,
      { type: 'write', path: 'draft', content: 'temporary replacement' },
      { tombstonedAt: 200 },
    );
    const deleted = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'delete', path: 'draft' },
      { tombstonedAt: 300 },
    );
    const empty = (await tree.putDirectory([])).cid;
    const recreated = await mutateProfileDriveRoot(
      tree,
      empty,
      { type: 'write', path: 'draft', content: 'recreated file' },
    );
    const prepared = await prepareProfileDriveRootForPublishResult(
      tree,
      recreated,
      deleted,
    );
    const result = await projectPair(
      tree,
      reader,
      originalWriter,
      originalRoot,
      replacementWriter,
      prepared.root,
    );

    expect((await tree.resolvePath(result, ['draft']))?.type).toBe(LinkType.Blob);
    expect((await tree.listDirectory(result)).some((entry) => (
      entry.name === `draft (conflict from ${originalPubkey})`
    ))).toBe(false);
  });
});

async function rootWithFiles(tree: HashTree, files: Record<string, string>): Promise<CID> {
  let root = (await tree.putDirectory([])).cid;
  for (const [path, content] of Object.entries(files)) {
    root = await mutateProfileDriveRoot(
      tree,
      root,
      { type: 'write', path, content },
      { recordTombstones: false },
    );
  }
  return root;
}

async function projectPair(
  tree: HashTree,
  reader: Uint8Array,
  originalWriter: Uint8Array,
  originalRoot: CID,
  replacementWriter: Uint8Array,
  replacementRoot: CID,
): Promise<CID> {
  const originalPubkey = getPublicKey(originalWriter);
  const original = driveRoot(originalWriter, getPublicKey(reader), originalRoot, 1, 50);
  const replacement = driveRoot(
    replacementWriter,
    getPublicKey(reader),
    replacementRoot,
    2,
    999,
    { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(originalRoot.hash) } },
  );
  const projection = new ProfileDriveProjection();
  projection.add(original, parseDriveRootEventForDevice(original, reader));
  projection.add(replacement, parseDriveRootEventForDevice(replacement, reader));
  return (await projection.materialize(
    tree,
    PROFILE_ID,
    'main',
    new Set([originalPubkey, getPublicKey(replacementWriter)]),
  ))!.root;
}

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
