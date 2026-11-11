import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';
import { DirectoryBuilder } from '../src/drive/directoryBuilder';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

type Fixture = {
  directories: Array<{ path: string; meta?: Record<string, unknown> }>;
  files: Array<{ path: string; text: string; meta?: Record<string, unknown> }>;
};

/** The reference result: edit a stored tree one path at a time, parents first. */
async function rootEditedOnePathAtATime(tree: HashTree, fixture: Fixture): Promise<CID> {
  let root = (await tree.putDirectory([])).cid;
  const empty = (await tree.putDirectory([])).cid;
  const depth = (path: string) => path.split('/').length;
  for (const { path, meta } of [...fixture.directories].sort((a, b) => depth(a.path) - depth(b.path))) {
    const segments = path.split('/');
    const name = segments.pop()!;
    root = await tree.setEntry(root, segments, name, empty, 0, LinkType.Dir, meta);
  }
  for (const { path, text, meta } of fixture.files) {
    const segments = path.split('/');
    const name = segments.pop()!;
    const file = await tree.putFile(new TextEncoder().encode(text));
    root = await tree.setEntry(root, segments, name, file.cid, file.size, LinkType.Blob, meta);
  }
  return root;
}

async function materialize(tree: HashTree, roots: CID[]) {
  const reader = generateSecretKey();
  const projection = new ProfileDriveProjection();
  const appKeys = roots.map((root, index) => {
    const signer = generateSecretKey();
    const event = buildDriveRootEvent({
      deviceSecretKey: signer,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100 + index,
      authorizedAppKeyPubkeys: [getPublicKey(reader)],
    });
    projection.add(event, parseDriveRootEventForDevice(event, reader));
    return getPublicKey(signer);
  });
  return (await projection.materialize(tree, PROFILE_ID, 'main', new Set(appKeys)))!;
}

async function visiblePaths(tree: HashTree, directory: CID, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await tree.listDirectory(directory)) {
    const path = `${prefix}${entry.name}`;
    if (entry.type === LinkType.Dir) paths.push(`${path}/`, ...await visiblePaths(tree, entry.cid, `${path}/`));
    else paths.push(path);
  }
  return paths;
}

describe('profile Drive merged root materialization', () => {
  it('is byte-identical to editing the tree one path at a time', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const fixture: Fixture = {
      directories: [
        { path: 'docs', meta: { created_at: 5 } },
        { path: 'docs/reports' },
        { path: 'docs/reports/2026', meta: { label: 'year' } },
        { path: 'empty', meta: { created_at: 7 } },
        { path: 'photos' },
        { path: 'photos/empty-album' },
      ],
      files: [
        { path: 'readme.txt', text: 'top level' },
        { path: 'docs/notes.md', text: 'notes', meta: { mtime: 11 } },
        { path: 'docs/reports/2026/q1.txt', text: 'first quarter' },
        { path: 'docs/reports/2026/q2.txt', text: 'second quarter' },
        // More entries than fit in one directory node, so the listing fans out.
        ...Array.from({ length: 300 }, (_, index) => ({
          path: `photos/img-${String(index).padStart(3, '0')}.jpg`,
          text: `photo ${index}`,
        })),
      ],
    };
    const expected = await rootEditedOnePathAtATime(tree, fixture);

    const result = await materialize(tree, [expected]);

    expect(toHex(result.root.hash)).toBe(toHex(expected.hash));
    expect(toHex(result.root.key!)).toBe(toHex(expected.key!));
  });

  it('stores each merged directory once instead of rewriting parents per file', async () => {
    const store = new MemoryStore();
    const tree = new HashTree({ store });
    const photos = await rootEditedOnePathAtATime(tree, {
      directories: [{ path: 'photos' }],
      files: Array.from({ length: 300 }, (_, index) => ({ path: `photos/img-${index}.jpg`, text: `photo ${index}` })),
    });
    const docs = await rootEditedOnePathAtATime(tree, {
      directories: [{ path: 'docs' }, { path: 'docs/reports' }, { path: 'photos' }],
      files: [
        { path: 'docs/reports/q1.txt', text: 'first quarter' },
        { path: 'photos/from-laptop.jpg', text: 'laptop photo' },
      ],
    });
    let writes = 0;
    const put = store.put.bind(store);
    store.put = (hash, data) => { writes += 1; return put(hash, data); };

    const result = await materialize(tree, [photos, docs]);

    const paths = await visiblePaths(tree, result.root);
    expect(paths).toHaveLength(300 + 2 + 3);
    expect(paths).toEqual(expect.arrayContaining([
      'docs/', 'docs/reports/', 'docs/reports/q1.txt', 'photos/', 'photos/img-0.jpg', 'photos/img-299.jpg',
      'photos/from-laptop.jpg',
    ]));
    // Four directories; the large one spans a few nodes. One edit per file wrote more than 700.
    expect(writes).toBeLessThan(12);
  });

  it('lets a file replace a directory of the same name and refuses to descend into a file', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const file = await tree.putFile(new TextEncoder().encode('x'));
    const leaf = { cid: file.cid, size: file.size, type: LinkType.Blob };
    const builder = new DirectoryBuilder();
    builder.directory(['a', 'nested']).setLeaf('inner.txt', leaf);
    builder.directory(['kept']).setLeaf('b.txt', leaf);

    builder.setLeaf('a', leaf);

    expect(() => builder.directory(['a', 'nested'])).toThrow('Path not found: a');
    expect(await visiblePaths(tree, await builder.put(tree))).toEqual(['a', 'kept/', 'kept/b.txt']);
  });
});
