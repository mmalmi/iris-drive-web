import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  mutateProfileDriveRoot,
  prepareProfileDriveRootForPublish,
} from '../src/drive/profileDriveMutation';
import { readPathKindReplacements } from '../src/drive/profileDrivePathKindMetadata';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('persistent profile Drive path-kind replacements', () => {
  it('treats a valid active role as a kind barrier and keeps carried child deletes effective', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const original = await rootWithFiles(tree, {
      'draft/deleted.txt': 'must stay deleted',
      'draft/keep.txt': 'must survive',
    });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'delete', path: 'draft/deleted.txt' },
      { tombstonedAt: 100 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'write', path: 'draft', content: 'replacement' },
      { tombstonedAt: 200 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);

    expect([...(await readPathKindReplacements(tree, replacement)).roles])
      .toEqual([['draft', 200]]);
    const result = await project(
      tree,
      reader,
      originalWriter,
      original,
      replacementWriter,
      replacement,
    );
    expect((await tree.resolvePath(result, ['draft']))?.type).toBe(LinkType.Blob);
    const conflict = `draft (conflict from ${originalPubkey})`;
    expect(await textAt(tree, result, [conflict, 'keep.txt'])).toBe('must survive');
    expect(await tree.resolvePath(result, [conflict, 'deleted.txt'])).toBeNull();
  });

  it('clears an active role during rapid unpublished delete and recreation', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const original = await rootWithFiles(tree, { 'draft/old.txt': 'old subtree' });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'first replacement' },
      { tombstonedAt: 200 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'delete', path: 'draft' },
      { tombstonedAt: 300 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'write', path: 'draft', content: 'recreated' },
      { tombstonedAt: 400 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);

    expect((await readPathKindReplacements(tree, replacement)).roles.size).toBe(0);
    const result = await project(
      tree,
      reader,
      originalWriter,
      original,
      replacementWriter,
      replacement,
    );
    expect(await textAt(tree, result, ['draft'])).toBe('recreated');
    expect((await tree.listDirectory(result)).some((entry) => (
      entry.name.startsWith('draft (conflict from ')
    ))).toBe(false);
  });

  it('retains an active replacement through a metadata-free unrelated edit', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const original = await rootWithFiles(tree, { 'draft/keep.txt': 'kept subtree' });
    let first = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement' },
      { tombstonedAt: 200 },
    );
    first = await prepareProfileDriveRootForPublish(tree, first);

    let logical = await rootWithFiles(tree, { draft: 'replacement' });
    logical = await mutateProfileDriveRoot(tree, logical, {
      type: 'write',
      path: 'unrelated.txt',
      content: 'later edit',
    });
    const prepared = await prepareProfileDriveRootForPublish(tree, logical, first);

    expect([...(await readPathKindReplacements(tree, prepared)).roles])
      .toEqual([['draft', 200]]);
    const result = await project(
      tree,
      reader,
      originalWriter,
      original,
      replacementWriter,
      prepared,
    );
    expect(await textAt(tree, result, ['draft'])).toBe('replacement');
    expect(await textAt(tree, result, [
      `draft (conflict from ${originalPubkey})`,
      'keep.txt',
    ])).toBe('kept subtree');
  });

  it('keeps remote active replacements canonical after the original AppKey republishes unrelated changes', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const originalPubkey = getPublicKey(originalWriter);
    const replacementPubkey = getPublicKey(replacementWriter);
    const original = await rootWithFiles(tree, {
      'kind-folder/old.txt': 'old directory bytes',
      'kind-file': 'old file bytes',
    });

    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'kind-folder', content: 'replacement file bytes' },
      { tombstonedAt: 200 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'mkdir', path: 'kind-file' },
      { tombstonedAt: 300 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'write', path: 'kind-file/new.txt', content: 'replacement directory bytes' },
      { tombstonedAt: 400 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);
    expect([...(await readPathKindReplacements(tree, replacement)).roles]).toEqual([
      ['kind-file', 300],
      ['kind-folder', 200],
    ]);

    let originalRepublish = await mutateProfileDriveRoot(tree, original, {
      type: 'write',
      path: 'unrelated.txt',
      content: 'later original-device edit',
    });
    originalRepublish = await prepareProfileDriveRootForPublish(
      tree,
      originalRepublish,
      original,
    );
    const originalRepublishRoles = await readPathKindReplacements(tree, originalRepublish);
    expect(originalRepublishRoles.present).toBe(true);
    expect(originalRepublishRoles.roles.size).toBe(0);

    const originalEvent = driveRoot(originalWriter, readerPubkey, original, 1, 50);
    const replacementEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      replacement,
      1,
      900,
      { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) } },
    );
    const originalRepublishEvent = driveRoot(
      originalWriter,
      readerPubkey,
      originalRepublish,
      2,
      1_000,
      {
        [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) },
        [replacementPubkey]: { app_key_seq: 1, root_cid: toHex(replacement.hash) },
      },
    );
    const result = await projectEvents(tree, reader, [
      originalEvent,
      replacementEvent,
      originalRepublishEvent,
    ]);

    expect(await textAt(tree, result, ['kind-folder'])).toBe('replacement file bytes');
    expect(await textAt(tree, result, [
      `kind-folder (conflict from ${originalPubkey})`,
      'old.txt',
    ])).toBe('old directory bytes');
    expect(await textAt(tree, result, ['kind-file', 'new.txt']))
      .toBe('replacement directory bytes');
    expect(await textAt(tree, result, [
      `kind-file (conflict from ${originalPubkey})`,
    ])).toBe('old file bytes');
    expect(await textAt(tree, result, ['unrelated.txt'])).toBe('later original-device edit');
  });

  it('lets a causally newer active role replace an older active role', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const originalPubkey = getPublicKey(originalWriter);
    const replacementPubkey = getPublicKey(replacementWriter);
    const original = await rootWithFiles(tree, { 'draft/old.txt': 'original directory' });

    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 200 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);

    let newer = await rootWithFiles(tree, { draft: 'replacement file' });
    newer = await mutateProfileDriveRoot(
      tree,
      newer,
      { type: 'mkdir', path: 'draft' },
      { tombstonedAt: 300 },
    );
    newer = await mutateProfileDriveRoot(
      tree,
      newer,
      { type: 'write', path: 'draft/new.txt', content: 'newer directory' },
      { tombstonedAt: 400 },
    );
    newer = await prepareProfileDriveRootForPublish(tree, newer, original);
    expect([...(await readPathKindReplacements(tree, newer)).roles])
      .toEqual([['draft', 300]]);

    const replacementEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      replacement,
      1,
      900,
      { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) } },
    );
    const newerEvent = driveRoot(
      originalWriter,
      readerPubkey,
      newer,
      2,
      1_000,
      {
        [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) },
        [replacementPubkey]: { app_key_seq: 1, root_cid: toHex(replacement.hash) },
      },
    );
    const result = await projectEvents(tree, reader, [replacementEvent, newerEvent]);

    expect(await textAt(tree, result, ['draft', 'new.txt'])).toBe('newer directory');
    expect(await textAt(tree, result, [
      `draft (conflict from ${replacementPubkey})`,
    ])).toBe('replacement file');
  });

  it('does not revive remote roles after an explicit delete and recreation', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const originalPubkey = getPublicKey(originalWriter);
    const replacementPubkey = getPublicKey(replacementWriter);
    const original = await rootWithFiles(tree, {
      'kind-folder/old.txt': 'original directory',
      'kind-file': 'original file',
    });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'kind-folder', content: 'remote file replacement' },
      { tombstonedAt: 200 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'mkdir', path: 'kind-file' },
      { tombstonedAt: 300 },
    );
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'write', path: 'kind-file/remote.txt', content: 'remote directory replacement' },
      { tombstonedAt: 400 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);

    let recreated = await rootWithFiles(tree, {
      'kind-folder': 'remote file replacement',
      'kind-file/remote.txt': 'remote directory replacement',
    });
    recreated = await mutateProfileDriveRoot(
      tree,
      recreated,
      { type: 'delete', path: 'kind-folder' },
      { tombstonedAt: 500 },
    );
    recreated = await mutateProfileDriveRoot(
      tree,
      recreated,
      { type: 'mkdir', path: 'kind-folder' },
      { tombstonedAt: 600 },
    );
    recreated = await mutateProfileDriveRoot(
      tree,
      recreated,
      { type: 'write', path: 'kind-folder/local.txt', content: 'explicit local directory' },
      { tombstonedAt: 700 },
    );
    recreated = await mutateProfileDriveRoot(
      tree,
      recreated,
      { type: 'delete', path: 'kind-file' },
      { tombstonedAt: 800 },
    );
    recreated = await mutateProfileDriveRoot(
      tree,
      recreated,
      { type: 'write', path: 'kind-file', content: 'explicit local file' },
      { tombstonedAt: 900 },
    );
    recreated = await prepareProfileDriveRootForPublish(tree, recreated, original);
    expect((await readPathKindReplacements(tree, recreated)).roles.size).toBe(0);

    const replacementEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      replacement,
      1,
      1_000,
      { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) } },
    );
    const recreatedEvent = driveRoot(
      originalWriter,
      readerPubkey,
      recreated,
      2,
      1_100,
      {
        [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) },
        [replacementPubkey]: { app_key_seq: 1, root_cid: toHex(replacement.hash) },
      },
    );
    const result = await projectEvents(tree, reader, [replacementEvent, recreatedEvent]);

    expect(await textAt(tree, result, ['kind-folder', 'local.txt']))
      .toBe('explicit local directory');
    expect(await textAt(tree, result, ['kind-file'])).toBe('explicit local file');
    expect((await tree.listDirectory(result)).some((entry) => (
      entry.name.startsWith('kind-folder (conflict from ')
      || entry.name.startsWith('kind-file (conflict from ')
    ))).toBe(false);
  });

  it('preserves both same-kind replacers and the losing directory when marker and event order disagree', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacerA = generateSecretKey();
    const replacerB = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const original = await rootWithFiles(tree, { 'draft/keep.txt': 'old subtree' });
    let rootA = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement A' },
      { tombstonedAt: 500 },
    );
    rootA = await prepareProfileDriveRootForPublish(tree, rootA);
    let rootB = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement B' },
      { tombstonedAt: 600 },
    );
    rootB = await prepareProfileDriveRootForPublish(tree, rootB);

    const originalEvent = driveRoot(originalWriter, getPublicKey(reader), original, 1, 50);
    const observed = { [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) } };
    // A wins event ordering, B wins marker ordering. Both replacement barriers
    // must be removed before per-candidate file selection.
    const eventA = driveRoot(replacerA, getPublicKey(reader), rootA, 2, 1_000, observed);
    const eventB = driveRoot(replacerB, getPublicKey(reader), rootB, 2, 900, observed);
    const result = await projectEvents(tree, reader, [originalEvent, eventA, eventB]);

    expect(await textAt(tree, result, ['draft'])).toBe('replacement A');
    expect(await textAt(tree, result, [
      `draft (conflict from ${getPublicKey(replacerB)})`,
    ])).toBe('replacement B');
    expect(await textAt(tree, result, [
      `draft (conflict from ${originalPubkey})`,
      'keep.txt',
    ])).toBe('old subtree');
  });

  it('keeps two active replacement paths with independent generations', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let root = await rootWithFiles(tree, {
      'alpha/old.txt': 'alpha old',
      'beta/old.txt': 'beta old',
    });
    root = await mutateProfileDriveRoot(
      tree,
      root,
      { type: 'write', path: 'alpha', content: 'alpha new' },
      { tombstonedAt: 200 },
    );
    root = await mutateProfileDriveRoot(
      tree,
      root,
      { type: 'write', path: 'beta', content: 'beta new' },
      { tombstonedAt: 300 },
    );
    root = await prepareProfileDriveRootForPublish(tree, root);

    expect([...(await readPathKindReplacements(tree, root)).roles]).toEqual([
      ['alpha', 200],
      ['beta', 300],
    ]);
  });

  it('clears a published replacement role before recreating from a metadata-free root', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const original = await rootWithFiles(tree, { 'draft/old.txt': 'old subtree' });
    let active = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement' },
      { tombstonedAt: 200 },
    );
    active = await prepareProfileDriveRootForPublish(tree, active);
    let deleted = await mutateProfileDriveRoot(
      tree,
      active,
      { type: 'delete', path: 'draft' },
      { tombstonedAt: 300 },
    );
    deleted = await prepareProfileDriveRootForPublish(tree, deleted, active);

    let logical = (await tree.putDirectory([])).cid;
    logical = await mutateProfileDriveRoot(
      tree,
      logical,
      { type: 'write', path: 'draft', content: 'recreated' },
      { tombstonedAt: 400 },
    );
    const recreated = await prepareProfileDriveRootForPublish(tree, logical, deleted);
    expect((await readPathKindReplacements(tree, recreated)).roles.size).toBe(0);

    const result = await project(
      tree,
      reader,
      originalWriter,
      original,
      replacementWriter,
      recreated,
    );
    expect(await textAt(tree, result, ['draft'])).toBe('recreated');
    expect((await tree.listDirectory(result)).some((entry) => (
      entry.name.startsWith('draft (conflict from ')
    ))).toBe(false);
  });

  it('clears roles under a renamed subtree instead of inventing target conflicts', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    let root = await rootWithFiles(tree, { 'folder/item/old.txt': 'old subtree' });
    root = await mutateProfileDriveRoot(
      tree,
      root,
      { type: 'write', path: 'folder/item', content: 'replacement' },
      { tombstonedAt: 200 },
    );
    root = await prepareProfileDriveRootForPublish(tree, root);
    expect([...(await readPathKindReplacements(tree, root)).roles])
      .toEqual([['folder/item', 200]]);
    const beforeRename = root;
    root = await mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: 'folder',
      to: 'renamed',
    }, { tombstonedAt: 300 });
    root = await prepareProfileDriveRootForPublish(tree, root, beforeRename);

    expect((await readPathKindReplacements(tree, root)).roles.size).toBe(0);
    expect(await textAt(tree, root, ['renamed', 'item'])).toBe('replacement');
  });

  it('keeps an ordinary later delete final after an active replacement', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const original = await rootWithFiles(tree, { 'draft/old.txt': 'old subtree' });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement' },
      { tombstonedAt: 200 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);
    replacement = await mutateProfileDriveRoot(
      tree,
      replacement,
      { type: 'delete', path: 'draft' },
      { tombstonedAt: 300 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);

    const result = await project(
      tree,
      reader,
      originalWriter,
      original,
      replacementWriter,
      replacement,
    );
    expect(await tree.resolvePath(result, ['draft'])).toBeNull();
    expect((await tree.listDirectory(result)).some((entry) => (
      entry.name.startsWith('draft (conflict from ')
    ))).toBe(false);
  });

  it('does not duplicate a materialized directory conflict after an unrelated republish', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const readerPubkey = getPublicKey(reader);
    const original = await rootWithFiles(tree, {
      'draft/keep.txt': 'old subtree',
    });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft', content: 'replacement file' },
      { tombstonedAt: 200 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);
    const observed = {
      [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) },
    };
    const originalEvent = driveRoot(originalWriter, readerPubkey, original, 1, 50);
    const replacementEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      replacement,
      2,
      900,
      observed,
    );
    const materialized = await projectEvents(tree, reader, [originalEvent, replacementEvent]);
    const originalDirectory = await tree.resolvePath(original, ['draft']);
    const materializedDirectory = await tree.resolvePath(materialized, [
      `draft (conflict from ${originalPubkey})`,
    ]);
    expect(toHex(materializedDirectory!.cid.hash)).toBe(toHex(originalDirectory!.cid.hash));

    let republished = await mutateProfileDriveRoot(tree, materialized, {
      type: 'write',
      path: 'unrelated.txt',
      content: 'later edit',
    });
    republished = await prepareProfileDriveRootForPublish(tree, republished, replacement);
    const republishedEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      republished,
      3,
      1_000,
      observed,
    );
    const result = await projectEvents(tree, reader, [originalEvent, republishedEvent]);

    const conflicts = (await tree.listDirectory(result)).filter((entry) => (
      entry.name.startsWith(`draft (conflict from ${originalPubkey}`)
      && entry.type === LinkType.Dir
    ));
    expect(conflicts).toHaveLength(1);
    expect(await textAt(tree, result, [conflicts[0].name, 'keep.txt'])).toBe('old subtree');
    expect(await textAt(tree, result, ['unrelated.txt'])).toBe('later edit');
  });

  it('does not duplicate a materialized file conflict after an unrelated republish', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const originalWriter = generateSecretKey();
    const replacementWriter = generateSecretKey();
    const originalPubkey = getPublicKey(originalWriter);
    const readerPubkey = getPublicKey(reader);
    const original = await rootWithFiles(tree, { draft: 'old file' });
    let replacement = await mutateProfileDriveRoot(
      tree,
      original,
      { type: 'write', path: 'draft/new.txt', content: 'new directory child' },
      { tombstonedAt: 200 },
    );
    replacement = await prepareProfileDriveRootForPublish(tree, replacement);
    const observed = {
      [originalPubkey]: { app_key_seq: 1, root_cid: toHex(original.hash) },
    };
    const originalEvent = driveRoot(originalWriter, readerPubkey, original, 1, 50);
    const replacementEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      replacement,
      2,
      900,
      observed,
    );
    const materialized = await projectEvents(tree, reader, [originalEvent, replacementEvent]);

    let republished = await mutateProfileDriveRoot(tree, materialized, {
      type: 'write',
      path: 'unrelated.txt',
      content: 'later edit',
    });
    republished = await prepareProfileDriveRootForPublish(tree, republished, replacement);
    const republishedEvent = driveRoot(
      replacementWriter,
      readerPubkey,
      republished,
      3,
      1_000,
      observed,
    );
    const result = await projectEvents(tree, reader, [originalEvent, republishedEvent]);

    const conflicts = (await tree.listDirectory(result)).filter((entry) => (
      entry.name.startsWith(`draft (conflict from ${originalPubkey}`)
      && entry.type !== LinkType.Dir
    ));
    expect(conflicts).toHaveLength(1);
    expect(await textAt(tree, result, [conflicts[0].name])).toBe('old file');
    expect(await textAt(tree, result, ['draft', 'new.txt'])).toBe('new directory child');
    expect(await textAt(tree, result, ['unrelated.txt'])).toBe('later edit');
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

async function project(
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

async function projectEvents(
  tree: HashTree,
  reader: Uint8Array,
  events: ReturnType<typeof driveRoot>[],
): Promise<CID> {
  const projection = new ProfileDriveProjection();
  for (const event of events) {
    projection.add(event, parseDriveRootEventForDevice(event, reader));
  }
  return (await projection.materialize(
    tree,
    PROFILE_ID,
    'main',
    new Set(events.map((event) => event.pubkey)),
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

async function textAt(tree: HashTree, root: CID, path: string[]): Promise<string | null> {
  const entry = await tree.resolvePath(root, path);
  if (!entry || entry.type === LinkType.Dir) return null;
  return new TextDecoder().decode(await tree.readFile(entry.cid) ?? undefined);
}
