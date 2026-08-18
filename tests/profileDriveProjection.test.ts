import { describe, expect, it } from 'vitest';
import {
  HashTree,
  LinkType,
  MemoryStore,
  toHex,
  type CID,
} from '@hashtree/core';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import {
  buildDriveRootEvent,
  parseDriveRootEventForDevice,
} from '../src/drive/protocol';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

async function fileCid(tree: HashTree, text: string): Promise<{ cid: CID; size: number }> {
  return tree.putFile(new TextEncoder().encode(text));
}

async function rootWithFile(tree: HashTree, name: string, text: string): Promise<CID> {
  const file = await fileCid(tree, text);
  return (await tree.putDirectory([{
    name,
    cid: file.cid,
    size: file.size,
    type: LinkType.Blob,
  }])).cid;
}

async function rootWithDirectoryFile(
  tree: HashTree,
  directoryName: string,
  fileName: string,
  text: string,
): Promise<CID> {
  const file = await fileCid(tree, text);
  const directory = await tree.putDirectory([{
    name: fileName,
    cid: file.cid,
    size: file.size,
    type: LinkType.Blob,
  }]);
  return (await tree.putDirectory([{
    name: directoryName,
    cid: directory.cid,
    size: directory.size,
    type: LinkType.Dir,
  }])).cid;
}

async function metadataOnlyRoot(tree: HashTree): Promise<CID> {
  const metadata = await fileCid(tree, JSON.stringify({ schema: 1 }));
  const metaDir = await tree.putDirectory([{
    name: 'root.json',
    cid: metadata.cid,
    size: metadata.size,
    type: LinkType.Blob,
  }]);
  return (await tree.putDirectory([{
    name: '.hashtree',
    cid: metaDir.cid,
    size: metaDir.size,
    type: LinkType.Dir,
  }])).cid;
}

async function rootWithTombstone(tree: HashTree, path: string, timestamp: number): Promise<CID> {
  const marker = await fileCid(tree, String(timestamp));
  const segments = path.split('/');
  const leaf = segments.pop()!;
  let tombstoneDir = (await tree.putDirectory([{
    name: leaf,
    cid: marker.cid,
    size: marker.size,
    type: LinkType.Blob,
  }])).cid;
  while (segments.length > 0) {
    tombstoneDir = (await tree.putDirectory([{
      name: segments.pop()!,
      cid: tombstoneDir,
      size: 0,
      type: LinkType.Dir,
    }])).cid;
  }
  const tombstones = await tree.putDirectory([{
    name: 'tombstones',
    cid: tombstoneDir,
    size: 0,
    type: LinkType.Dir,
  }]);
  return (await tree.putDirectory([{
    name: '.hashtree',
    cid: tombstones.cid,
    size: 0,
    type: LinkType.Dir,
  }])).cid;
}

async function copyStore(source: MemoryStore, target: MemoryStore): Promise<void> {
  await Promise.all(source.keys().map(async (hash) => {
    const block = await source.get(hash);
    if (block) await target.put(hash, block);
  }));
}

function driveRoot(options: {
  signer: Uint8Array;
  readerPubkey: string;
  root: CID;
  sequence: number;
  publishedAt: number;
  observed?: Record<string, { app_key_seq: number; root_cid: string }>;
}): Event {
  return buildDriveRootEvent({
    deviceSecretKey: options.signer,
    rootScopeId: PROFILE_ID,
    driveId: 'main',
    root: options.root,
    dckGeneration: 1,
    appKeySeq: options.sequence,
    publishedAt: options.publishedAt,
    authorizedAppKeyPubkeys: [options.readerPubkey],
    observed: options.observed,
  });
}

describe('profile Drive projection', () => {
  it('materializes all authorized AppKey files without exposing .hashtree metadata', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const appA = generateSecretKey();
    const appB = generateSecretKey();
    const rootA = await rootWithFile(tree, 'from-ios.txt', 'already here');
    const rootB = await metadataOnlyRoot(tree);
    const eventA = driveRoot({ signer: appA, readerPubkey, root: rootA, sequence: 1, publishedAt: 100 });
    const eventB = driveRoot({ signer: appB, readerPubkey, root: rootB, sequence: 1, publishedAt: 200 });
    const projection = new ProfileDriveProjection();

    projection.add(eventA, parseDriveRootEventForDevice(eventA, reader));
    projection.add(eventB, parseDriveRootEventForDevice(eventB, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([getPublicKey(appA), getPublicKey(appB)]),
    );

    expect(result).not.toBeNull();
    const entries = await tree.listDirectory(result!.root);
    expect(entries.map((entry) => entry.name)).toEqual(['from-ios.txt']);
    expect(new TextDecoder().decode(await tree.readFile(entries[0].cid) ?? undefined)).toBe('already here');
    expect(result!.sourceRootCount).toBe(2);
  });

  it('keeps only the latest root per AppKey and excludes unauthorized roots', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const app = generateSecretKey();
    const unauthorized = generateSecretKey();
    const oldRoot = await rootWithFile(tree, 'old.txt', 'old');
    const newRoot = await rootWithFile(tree, 'new.txt', 'new');
    const injectedRoot = await rootWithFile(tree, 'injected.txt', 'nope');
    const oldEvent = driveRoot({ signer: app, readerPubkey, root: oldRoot, sequence: 1, publishedAt: 100 });
    const newEvent = driveRoot({ signer: app, readerPubkey, root: newRoot, sequence: 2, publishedAt: 101 });
    const injected = driveRoot({ signer: unauthorized, readerPubkey, root: injectedRoot, sequence: 99, publishedAt: 999 });
    const projection = new ProfileDriveProjection();

    projection.add(newEvent, parseDriveRootEventForDevice(newEvent, reader));
    expect(projection.add(oldEvent, parseDriveRootEventForDevice(oldEvent, reader))).toBe(false);
    projection.add(injected, parseDriveRootEventForDevice(injected, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([getPublicKey(app)]),
    );
    const entries = await tree.listDirectory(result!.root);
    expect(entries.map((entry) => entry.name)).toEqual(['new.txt']);
  });

  it('applies a causally newer tombstone and exposes root observations for web edits', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const writer = generateSecretKey();
    const remover = generateSecretKey();
    const writerPubkey = getPublicKey(writer);
    const removerPubkey = getPublicKey(remover);
    const fileRoot = await rootWithFile(tree, 'removed.txt', 'gone');
    const deleteRoot = await rootWithTombstone(tree, 'removed.txt', 200);
    const writeEvent = driveRoot({ signer: writer, readerPubkey, root: fileRoot, sequence: 4, publishedAt: 100 });
    const deleteEvent = driveRoot({
      signer: remover,
      readerPubkey,
      root: deleteRoot,
      sequence: 2,
      publishedAt: 200,
      observed: {
        [writerPubkey]: { app_key_seq: 4, root_cid: toHex(fileRoot.hash) },
      },
    });
    const projection = new ProfileDriveProjection();
    projection.add(writeEvent, parseDriveRootEventForDevice(writeEvent, reader));
    projection.add(deleteEvent, parseDriveRootEventForDevice(deleteEvent, reader));
    const authorized = new Set([writerPubkey, removerPubkey]);

    const result = await projection.materialize(tree, PROFILE_ID, 'main', authorized);
    expect(await tree.listDirectory(result!.root)).toEqual([]);
    expect(projection.observations(PROFILE_ID, 'main', authorized)).toEqual({
      [removerPubkey]: { app_key_seq: 2, root_cid: toHex(deleteRoot.hash) },
      [writerPubkey]: { app_key_seq: 4, root_cid: toHex(fileRoot.hash) },
    });
  });

  it('suppresses a deleted directory and all foreign descendants from one directory marker', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const writer = generateSecretKey();
    const remover = generateSecretKey();
    const writerPubkey = getPublicKey(writer);
    const removerPubkey = getPublicKey(remover);
    const nestedFile = await fileCid(tree, 'foreign bytes');
    const empty = await tree.putDirectory([]);
    const docs = await tree.putDirectory([
      { name: 'empty', cid: empty.cid, size: 0, type: LinkType.Dir },
      { name: 'note.txt', cid: nestedFile.cid, size: nestedFile.size, type: LinkType.Blob },
    ]);
    const foreignRoot = (await tree.putDirectory([{
      name: 'docs',
      cid: docs.cid,
      size: docs.size,
      type: LinkType.Dir,
    }])).cid;
    const deleteRoot = await rootWithTombstone(tree, 'docs', 200);
    const writeEvent = driveRoot({
      signer: writer,
      readerPubkey,
      root: foreignRoot,
      sequence: 1,
      publishedAt: 100,
    });
    const deleteEvent = driveRoot({
      signer: remover,
      readerPubkey,
      root: deleteRoot,
      sequence: 1,
      publishedAt: 200,
      observed: {
        [writerPubkey]: { app_key_seq: 1, root_cid: toHex(foreignRoot.hash) },
      },
    });
    const projection = new ProfileDriveProjection();
    projection.add(writeEvent, parseDriveRootEventForDevice(writeEvent, reader));
    projection.add(deleteEvent, parseDriveRootEventForDevice(deleteEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([writerPubkey, removerPubkey]),
    );

    expect(await tree.listDirectory(result!.root)).toEqual([]);
  });

  it('keeps both sides of a concurrent write as native-compatible visible conflict files', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const olderWriter = generateSecretKey();
    const newerWriter = generateSecretKey();
    const olderPubkey = getPublicKey(olderWriter);
    const newerPubkey = getPublicKey(newerWriter);
    const olderRoot = await rootWithFile(tree, 'docs/note.txt', 'older concurrent bytes');
    const newerRoot = await rootWithFile(tree, 'docs/note.txt', 'newer concurrent bytes');
    const olderEvent = driveRoot({
      signer: olderWriter,
      readerPubkey,
      root: olderRoot,
      sequence: 1,
      publishedAt: 100,
    });
    const newerEvent = driveRoot({
      signer: newerWriter,
      readerPubkey,
      root: newerRoot,
      sequence: 1,
      publishedAt: 101,
    });
    const projection = new ProfileDriveProjection();
    projection.add(olderEvent, parseDriveRootEventForDevice(olderEvent, reader));
    projection.add(newerEvent, parseDriveRootEventForDevice(newerEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([olderPubkey, newerPubkey]),
    );
    const docs = await tree.resolvePath(result!.root, ['docs']);
    expect(docs?.type).toBe(LinkType.Dir);
    const entries = await tree.listDirectory(docs!.cid);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      `note (conflict from ${olderPubkey}).txt`,
      'note.txt',
    ].sort());
    const contents = await Promise.all(entries.map(async (entry) => (
      new TextDecoder().decode(await tree.readFile(entry.cid) ?? undefined)
    )));
    expect(contents.sort()).toEqual(['newer concurrent bytes', 'older concurrent bytes']);
    expect((await tree.listDirectory(result!.root)).map((entry) => entry.name)).not.toContain('.hashtree');
  });

  it('keeps a concurrent write as a conflict copy when a delete wins', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const writer = generateSecretKey();
    const remover = generateSecretKey();
    const writerPubkey = getPublicKey(writer);
    const removerPubkey = getPublicKey(remover);
    const writeRoot = await rootWithFile(tree, 'docs/note.txt', 'edit concurrent with delete');
    const deleteRoot = await rootWithTombstone(tree, 'docs/note.txt', 200);
    const writeEvent = driveRoot({
      signer: writer,
      readerPubkey,
      root: writeRoot,
      sequence: 2,
      publishedAt: 100,
    });
    const deleteEvent = driveRoot({
      signer: remover,
      readerPubkey,
      root: deleteRoot,
      sequence: 2,
      publishedAt: 200,
    });
    const projection = new ProfileDriveProjection();
    projection.add(writeEvent, parseDriveRootEventForDevice(writeEvent, reader));
    projection.add(deleteEvent, parseDriveRootEventForDevice(deleteEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([writerPubkey, removerPubkey]),
    );
    expect(await tree.resolvePath(result!.root, ['docs', 'note.txt'])).toBeNull();
    const conflictPath = `docs/note (conflict from ${writerPubkey}).txt`;
    const conflict = await tree.resolvePath(result!.root, conflictPath.split('/'));
    expect(new TextDecoder().decode(await tree.readFile(conflict!.cid) ?? undefined))
      .toBe('edit concurrent with delete');
  });

  it('keeps a causally newer directory and preserves the replaced file as a conflict copy', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const fileWriter = generateSecretKey();
    const directoryWriter = generateSecretKey();
    const filePubkey = getPublicKey(fileWriter);
    const directoryPubkey = getPublicKey(directoryWriter);
    const fileRoot = await rootWithFile(tree, 'docs', 'the former file');
    const directoryRoot = await rootWithDirectoryFile(tree, 'docs', 'inside.txt', 'directory child');
    const fileEvent = driveRoot({
      signer: fileWriter,
      readerPubkey,
      root: fileRoot,
      sequence: 3,
      publishedAt: 100,
    });
    const directoryEvent = driveRoot({
      signer: directoryWriter,
      readerPubkey,
      root: directoryRoot,
      sequence: 2,
      publishedAt: 101,
      observed: {
        [filePubkey]: { app_key_seq: 3, root_cid: toHex(fileRoot.hash) },
      },
    });
    const projection = new ProfileDriveProjection();
    projection.add(fileEvent, parseDriveRootEventForDevice(fileEvent, reader));
    projection.add(directoryEvent, parseDriveRootEventForDevice(directoryEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([filePubkey, directoryPubkey]),
    );

    const docs = await tree.resolvePath(result!.root, ['docs']);
    expect(docs?.type).toBe(LinkType.Dir);
    const child = await tree.resolvePath(result!.root, ['docs', 'inside.txt']);
    expect(new TextDecoder().decode(await tree.readFile(child!.cid) ?? undefined))
      .toBe('directory child');
    const conflict = await tree.resolvePath(
      result!.root,
      [`docs (conflict from ${filePubkey})`],
    );
    expect(conflict?.type).toBe(LinkType.Blob);
    expect(new TextDecoder().decode(await tree.readFile(conflict!.cid) ?? undefined))
      .toBe('the former file');
  });

  it('keeps a directory canonical for a concurrent file-directory conflict', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const fileWriter = generateSecretKey();
    const directoryWriter = generateSecretKey();
    const filePubkey = getPublicKey(fileWriter);
    const directoryPubkey = getPublicKey(directoryWriter);
    const fileRoot = await rootWithFile(tree, 'workspace', 'concurrent file');
    const directoryRoot = await rootWithDirectoryFile(
      tree,
      'workspace',
      'kept.txt',
      'concurrent directory child',
    );
    const fileEvent = driveRoot({
      signer: fileWriter,
      readerPubkey,
      root: fileRoot,
      sequence: 1,
      publishedAt: 999,
    });
    const directoryEvent = driveRoot({
      signer: directoryWriter,
      readerPubkey,
      root: directoryRoot,
      sequence: 1,
      publishedAt: 100,
    });
    const projection = new ProfileDriveProjection();
    projection.add(fileEvent, parseDriveRootEventForDevice(fileEvent, reader));
    projection.add(directoryEvent, parseDriveRootEventForDevice(directoryEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([filePubkey, directoryPubkey]),
    );

    expect((await tree.resolvePath(result!.root, ['workspace']))?.type).toBe(LinkType.Dir);
    const child = await tree.resolvePath(result!.root, ['workspace', 'kept.txt']);
    expect(new TextDecoder().decode(await tree.readFile(child!.cid) ?? undefined))
      .toBe('concurrent directory child');
    const conflict = await tree.resolvePath(
      result!.root,
      [`workspace (conflict from ${filePubkey})`],
    );
    expect(new TextDecoder().decode(await tree.readFile(conflict!.cid) ?? undefined))
      .toBe('concurrent file');
  });

  it('preserves a causally replaced directory subtree under a conflict name', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const directoryWriter = generateSecretKey();
    const fileWriter = generateSecretKey();
    const directoryPubkey = getPublicKey(directoryWriter);
    const filePubkey = getPublicKey(fileWriter);
    const directoryRoot = await rootWithDirectoryFile(tree, 'draft', 'old.txt', 'old child');
    const fileRoot = await rootWithFile(tree, 'draft', 'replacement file');
    const directoryEvent = driveRoot({
      signer: directoryWriter,
      readerPubkey,
      root: directoryRoot,
      sequence: 4,
      publishedAt: 100,
    });
    const fileEvent = driveRoot({
      signer: fileWriter,
      readerPubkey,
      root: fileRoot,
      sequence: 2,
      publishedAt: 101,
      observed: {
        [directoryPubkey]: { app_key_seq: 4, root_cid: toHex(directoryRoot.hash) },
      },
    });
    const projection = new ProfileDriveProjection();
    projection.add(directoryEvent, parseDriveRootEventForDevice(directoryEvent, reader));
    projection.add(fileEvent, parseDriveRootEventForDevice(fileEvent, reader));

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([directoryPubkey, filePubkey]),
    );

    const replacement = await tree.resolvePath(result!.root, ['draft']);
    expect(replacement?.type).toBe(LinkType.Blob);
    expect(new TextDecoder().decode(await tree.readFile(replacement!.cid) ?? undefined))
      .toBe('replacement file');
    const conflictDirectory = `draft (conflict from ${directoryPubkey})`;
    expect((await tree.resolvePath(result!.root, [conflictDirectory]))?.type).toBe(LinkType.Dir);
    const oldChild = await tree.resolvePath(result!.root, [conflictDirectory, 'old.txt']);
    expect(new TextDecoder().decode(await tree.readFile(oldChild!.cid) ?? undefined))
      .toBe('old child');
  });

  it('never materializes a partial projection and can retry retained roots after blocks arrive', async () => {
    const availableStore = new MemoryStore();
    const delayedStore = new MemoryStore();
    const tree = new HashTree({ store: availableStore });
    const delayedTree = new HashTree({ store: delayedStore });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const appA = generateSecretKey();
    const appB = generateSecretKey();
    const rootA = await rootWithFile(tree, 'available.txt', 'ready');
    const rootB = await rootWithFile(delayedTree, 'delayed.txt', 'later');
    const eventA = driveRoot({ signer: appA, readerPubkey, root: rootA, sequence: 1, publishedAt: 100 });
    const eventB = driveRoot({ signer: appB, readerPubkey, root: rootB, sequence: 1, publishedAt: 101 });
    const projection = new ProfileDriveProjection();
    projection.add(eventA, parseDriveRootEventForDevice(eventA, reader));
    projection.add(eventB, parseDriveRootEventForDevice(eventB, reader));
    const authorized = new Set([getPublicKey(appA), getPublicKey(appB)]);
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 10);

    await expect(projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      authorized,
      controller.signal,
    )).rejects.toBeDefined();
    clearTimeout(abort);
    expect(projection.hasAuthorizedRoots(PROFILE_ID, 'main', authorized)).toBe(true);

    await copyStore(delayedStore, availableStore);
    const retried = await projection.materialize(tree, PROFILE_ID, 'main', authorized);
    expect((await tree.listDirectory(retried!.root)).map((entry) => entry.name)).toEqual([
      'available.txt',
      'delayed.txt',
    ]);
    expect(retried!.sourceRootCount).toBe(2);
  });

  it('evicts retained roots from AppKeys removed by a roster change', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const reader = generateSecretKey();
    const readerPubkey = getPublicKey(reader);
    const retainedApp = generateSecretKey();
    const revokedApp = generateSecretKey();
    const retainedPubkey = getPublicKey(retainedApp);
    const revokedPubkey = getPublicKey(revokedApp);
    const retainedRoot = await rootWithFile(tree, 'retained.txt', 'yes');
    const revokedRoot = await rootWithFile(tree, 'revoked.txt', 'no');
    const retainedEvent = driveRoot({ signer: retainedApp, readerPubkey, root: retainedRoot, sequence: 1, publishedAt: 100 });
    const revokedEvent = driveRoot({ signer: revokedApp, readerPubkey, root: revokedRoot, sequence: 1, publishedAt: 101 });
    const projection = new ProfileDriveProjection();
    projection.add(retainedEvent, parseDriveRootEventForDevice(retainedEvent, reader));
    projection.add(revokedEvent, parseDriveRootEventForDevice(revokedEvent, reader));

    expect(projection.pruneUnauthorized(PROFILE_ID, 'main', new Set([retainedPubkey]))).toBe(true);
    expect(projection.hasAuthorizedRoots(PROFILE_ID, 'main', new Set([revokedPubkey]))).toBe(false);

    const result = await projection.materialize(
      tree,
      PROFILE_ID,
      'main',
      new Set([retainedPubkey, revokedPubkey]),
    );
    expect((await tree.listDirectory(result!.root)).map((entry) => entry.name)).toEqual(['retained.txt']);
  });
});
