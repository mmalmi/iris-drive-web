import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';

const META_DIRECTORY = '.hashtree';
const TOMBSTONE_DIRECTORY = 'tombstones';

export type ProfileDriveMutation =
  | { type: 'write'; path: string; content: string | Uint8Array }
  | { type: 'mkdir'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string };

export interface ProfileDriveMutationOptions {
  recordTombstones?: boolean;
  tombstonedAt?: number;
}

/**
 * Apply the same visible-tree mutations used by the browser UI while layering
 * durable Iris Drive deletion markers. The returned root is publishable; its
 * `.hashtree` metadata is intentionally filtered out by the logical projection.
 */
export async function mutateProfileDriveRoot(
  tree: HashTree,
  root: CID,
  mutation: ProfileDriveMutation,
  options: ProfileDriveMutationOptions = {},
): Promise<CID> {
  const recordTombstones = options.recordTombstones !== false;
  const tombstonedAt = options.tombstonedAt ?? Math.floor(Date.now() / 1000);
  let nextRoot = root;
  const deletedPaths: string[] = [];
  const visiblePaths: string[] = [];

  if (mutation.type === 'write') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('write path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (existing?.type === LinkType.Dir) {
      deletedPaths.push(...await visiblePathsUnder(tree, nextRoot, [...parts, name]));
    }
    const ensured = await ensureParentDirectories(tree, nextRoot, parts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    if (existing?.type === LinkType.Dir) {
      nextRoot = await tree.removeEntry(nextRoot, parts, name);
    }
    const data = typeof mutation.content === 'string'
      ? new TextEncoder().encode(mutation.content)
      : mutation.content;
    const file = await tree.putFile(data);
    nextRoot = await tree.setEntry(nextRoot, parts, name, file.cid, file.size, LinkType.Blob);
    visiblePaths.push(mutation.path);
  } else if (mutation.type === 'mkdir') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('mkdir path is empty');
    deletedPaths.push(...await visiblePathsUnder(tree, nextRoot, [...parts, name]));
    const ensured = await ensureParentDirectories(tree, nextRoot, parts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (existing) nextRoot = await tree.removeEntry(nextRoot, parts, name);
    const empty = await tree.putDirectory([]);
    nextRoot = await tree.setEntry(nextRoot, parts, name, empty.cid, 0, LinkType.Dir);
    visiblePaths.push(mutation.path);
  } else if (mutation.type === 'delete') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('delete path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (!existing) return nextRoot;
    deletedPaths.push(...await visiblePathsUnder(tree, nextRoot, [...parts, name]));
    nextRoot = await tree.removeEntry(nextRoot, parts, name);
  } else {
    const fromParts = splitPath(mutation.from);
    const toParts = splitPath(mutation.to);
    const fromName = fromParts.pop();
    const toName = toParts.pop();
    if (!fromName || !toName) throw new Error('rename path is empty');

    const sourcePath = [...fromParts, fromName];
    const targetPath = [...toParts, toName];
    const source = await resolveEntry(tree, nextRoot, sourcePath);
    if (!source) throw new Error(`rename source missing: ${mutation.from}`);
    const sourcePaths = await visiblePathsUnder(tree, nextRoot, sourcePath);
    const renamedPaths = sourcePaths.map((path) => (
      path === mutation.from ? mutation.to : `${mutation.to}/${path.slice(mutation.from.length + 1)}`
    ));
    const renamedSet = new Set(renamedPaths);
    const replacedTargetPaths = (await visiblePathsUnder(tree, nextRoot, targetPath))
      .filter((path) => !renamedSet.has(path));
    deletedPaths.push(...sourcePaths, ...replacedTargetPaths);

    const target = await resolveEntry(tree, nextRoot, targetPath);
    if (target) nextRoot = await tree.removeEntry(nextRoot, toParts, toName);
    nextRoot = await tree.removeEntry(nextRoot, fromParts, fromName);
    const ensured = await ensureParentDirectories(tree, nextRoot, toParts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    nextRoot = await tree.setEntry(
      nextRoot,
      toParts,
      toName,
      source.cid,
      source.size,
      source.type,
      source.meta,
    );
    visiblePaths.push(...renamedPaths);
  }

  if (!recordTombstones) return nextRoot;
  return updateTombstones(tree, nextRoot, {
    add: deletedPaths,
    clear: visiblePaths,
    tombstonedAt,
  });
}

/**
 * Re-attach this AppKey's retained tombstones to a metadata-free logical root
 * immediately before signing it. A visible recreation at the same path wins
 * and clears the old marker.
 */
export async function prepareProfileDriveRootForPublish(
  tree: HashTree,
  root: CID,
  previousContribution?: CID | null,
): Promise<CID> {
  const retained = previousContribution
    ? await readTombstoneTimestamps(tree, previousContribution)
    : new Map<string, number>();
  const current = await readTombstoneTimestamps(tree, root);
  for (const [path, timestamp] of current) {
    retained.set(path, Math.max(retained.get(path) ?? 0, timestamp));
  }
  for (const path of await visiblePaths(tree, root)) retained.delete(path);
  return replaceTombstones(tree, root, retained);
}

async function updateTombstones(
  tree: HashTree,
  root: CID,
  options: { add: string[]; clear: string[]; tombstonedAt: number },
): Promise<CID> {
  const tombstones = await readTombstoneTimestamps(tree, root);
  for (const path of options.add) {
    if (path && !path.startsWith(`${META_DIRECTORY}/`)) {
      tombstones.set(path, Math.max(tombstones.get(path) ?? 0, options.tombstonedAt));
    }
  }
  for (const path of options.clear) tombstones.delete(path);
  return replaceTombstones(tree, root, tombstones);
}

async function replaceTombstones(
  tree: HashTree,
  root: CID,
  tombstones: ReadonlyMap<string, number>,
): Promise<CID> {
  const metadata = await resolveEntry(tree, root, [META_DIRECTORY]);
  let metadataRoot: CID;
  if (metadata?.type === LinkType.Dir) {
    metadataRoot = metadata.cid;
  } else {
    if (metadata) root = await tree.removeEntry(root, [], META_DIRECTORY);
    metadataRoot = (await tree.putDirectory([])).cid;
  }

  const existingTombstones = await resolveEntry(tree, metadataRoot, [TOMBSTONE_DIRECTORY]);
  if (existingTombstones) {
    metadataRoot = await tree.removeEntry(metadataRoot, [], TOMBSTONE_DIRECTORY);
  }

  if (tombstones.size > 0) {
    const tombstoneRoot = await buildTombstoneDirectory(tree, tombstones);
    metadataRoot = await tree.setEntry(
      metadataRoot,
      [],
      TOMBSTONE_DIRECTORY,
      tombstoneRoot,
      0,
      LinkType.Dir,
    );
  }

  const metadataEntries = await tree.listDirectory(metadataRoot);
  if (metadataEntries.length === 0) {
    return metadata ? tree.removeEntry(root, [], META_DIRECTORY) : root;
  }
  return tree.setEntry(root, [], META_DIRECTORY, metadataRoot, 0, LinkType.Dir);
}

type TombstoneTrie = {
  directories: Map<string, TombstoneTrie>;
  markers: Map<string, number>;
};

function emptyTombstoneTrie(): TombstoneTrie {
  return { directories: new Map(), markers: new Map() };
}

async function buildTombstoneDirectory(
  tree: HashTree,
  tombstones: ReadonlyMap<string, number>,
): Promise<CID> {
  const trie = emptyTombstoneTrie();
  for (const [path, timestamp] of [...tombstones].sort(([left], [right]) => left.localeCompare(right))) {
    const parts = splitPath(path);
    const leaf = parts.pop();
    if (!leaf) continue;
    let node = trie;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (!child) {
        child = emptyTombstoneTrie();
        node.directories.set(part, child);
      }
      node = child;
    }
    node.markers.set(leaf, timestamp);
  }

  const materialize = async (node: TombstoneTrie): Promise<CID> => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of [...node.directories].sort(([left], [right]) => left.localeCompare(right))) {
      const cid = await materialize(child);
      entries.push({ name, cid, size: 0, type: LinkType.Dir });
    }
    for (const [name, timestamp] of [...node.markers].sort(([left], [right]) => left.localeCompare(right))) {
      const marker = await tree.putFile(new TextEncoder().encode(String(timestamp)));
      entries.push({ name, cid: marker.cid, size: marker.size, type: LinkType.Blob });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return (await tree.putDirectory(entries)).cid;
  };
  return materialize(trie);
}

async function readTombstoneTimestamps(tree: HashTree, root: CID): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const tombstones = await resolveEntry(tree, root, [META_DIRECTORY, TOMBSTONE_DIRECTORY]);
  if (!tombstones || tombstones.type !== LinkType.Dir) return out;

  const walk = async (directory: CID, prefix: string): Promise<void> => {
    for (const entry of await tree.listDirectory(directory)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === LinkType.Dir) {
        await walk(entry.cid, path);
        continue;
      }
      const raw = await tree.readFile(entry.cid);
      if (!raw) continue;
      const timestamp = Number(new TextDecoder().decode(raw).trim());
      if (Number.isSafeInteger(timestamp)) out.set(path, timestamp);
    }
  };
  await walk(tombstones.cid, '');
  return out;
}

async function visiblePaths(tree: HashTree, root: CID): Promise<string[]> {
  const paths: string[] = [];
  const walk = async (directory: CID, prefix: string): Promise<void> => {
    for (const entry of await tree.listDirectory(directory)) {
      if (!prefix && entry.name === META_DIRECTORY) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(path);
      if (entry.type === LinkType.Dir) await walk(entry.cid, path);
    }
  };
  await walk(root, '');
  return paths;
}

async function visiblePathsUnder(
  tree: HashTree,
  root: CID,
  targetParts: string[],
): Promise<string[]> {
  if (targetParts[0] === META_DIRECTORY) return [];
  const entry = await resolveEntry(tree, root, targetParts);
  if (!entry) return [];
  const targetPath = targetParts.join('/');
  if (entry.type !== LinkType.Dir) return [targetPath];

  const paths: string[] = [targetPath];
  const walk = async (directory: CID, parts: string[]): Promise<void> => {
    for (const child of await tree.listDirectory(directory)) {
      const childParts = [...parts, child.name];
      paths.push(childParts.join('/'));
      if (child.type === LinkType.Dir) await walk(child.cid, childParts);
    }
  };
  await walk(entry.cid, targetParts);
  return paths;
}

async function ensureParentDirectories(
  tree: HashTree,
  root: CID,
  parts: string[],
): Promise<{ root: CID; replacedFiles: string[] }> {
  let nextRoot = root;
  const replacedFiles: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const path = parts.slice(0, index + 1);
    const parent = parts.slice(0, index);
    const name = parts[index];
    const existing = await resolveEntry(tree, nextRoot, path);
    if (existing?.type === LinkType.Dir) continue;
    if (existing) {
      replacedFiles.push(path.join('/'));
      nextRoot = await tree.removeEntry(nextRoot, parent, name);
    }
    const empty = await tree.putDirectory([]);
    nextRoot = await tree.setEntry(nextRoot, parent, name, empty.cid, 0, LinkType.Dir);
  }
  return { root: nextRoot, replacedFiles };
}

async function resolveEntry(
  tree: HashTree,
  root: CID,
  parts: string[],
): Promise<TreeEntry | null> {
  const name = parts.at(-1);
  if (!name) return null;
  const parentParts = parts.slice(0, -1);
  const parent = parentParts.length > 0
    ? await tree.resolvePath(root, parentParts).catch(() => null)
    : { cid: root, type: LinkType.Dir };
  if (!parent?.cid || parent.type !== LinkType.Dir) return null;
  const entries = await tree.listDirectory(parent.cid).catch(() => []);
  return entries.find((entry) => entry.name === name) ?? null;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
