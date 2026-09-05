import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import {
  applyPathKindReplacementOperations,
  readPathKindReplacementDelta,
  readPathKindReplacements,
  replacePathKindReplacementDelta,
  replacePathKindReplacements,
  type PathKindReplacementOperation,
} from './profileDrivePathKindMetadata';

const META_DIRECTORY = '.hashtree';
const TOMBSTONE_DIRECTORY = 'tombstones';
const AUTHORED_TOMBSTONES_FILE = 'authored-tombstones.json';

export type ProfileDriveMutation =
  | { type: 'write'; path: string; content: string | Uint8Array }
  | { type: 'mkdir'; path: string }
  | { type: 'set-entry'; path: string; entry: Omit<TreeEntry, 'name'> }
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
  let nextRoot = root;
  const deletedPaths: string[] = [];
  const replacementPaths: string[] = [];
  const roleOperations: PathKindReplacementOperation[] = [];

  if (mutation.type === 'write') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('write path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (existing?.type === LinkType.Dir) {
      deletedPaths.push(mutation.path);
      replacementPaths.push(mutation.path);
    } else if (!existing) {
      roleOperations.push({ op: 'clear', path: mutation.path });
    }
    const ensured = await ensureParentDirectories(tree, nextRoot, parts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    replacementPaths.push(...ensured.replacedFiles);
    if (existing?.type === LinkType.Dir) {
      nextRoot = await tree.removeEntry(nextRoot, parts, name);
    }
    const data = typeof mutation.content === 'string'
      ? new TextEncoder().encode(mutation.content)
      : mutation.content;
    const file = await tree.putFile(data);
    nextRoot = await tree.setEntry(nextRoot, parts, name, file.cid, file.size, LinkType.Blob);
  } else if (mutation.type === 'mkdir') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('mkdir path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (existing?.type === LinkType.Dir) return nextRoot;
    if (existing) {
      deletedPaths.push(mutation.path);
      replacementPaths.push(mutation.path);
    } else {
      roleOperations.push({ op: 'clear', path: mutation.path });
    }
    const ensured = await ensureParentDirectories(tree, nextRoot, parts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    replacementPaths.push(...ensured.replacedFiles);
    if (existing) nextRoot = await tree.removeEntry(nextRoot, parts, name);
    const empty = await tree.putDirectory([]);
    nextRoot = await tree.setEntry(nextRoot, parts, name, empty.cid, 0, LinkType.Dir);
  } else if (mutation.type === 'set-entry') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('set-entry path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (existing && existing.type !== mutation.entry.type) {
      deletedPaths.push(mutation.path);
      replacementPaths.push(mutation.path);
    } else if (!existing) {
      roleOperations.push({ op: 'clear', path: mutation.path });
    }
    const ensured = await ensureParentDirectories(tree, nextRoot, parts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    replacementPaths.push(...ensured.replacedFiles);
    if (existing) nextRoot = await tree.removeEntry(nextRoot, parts, name);
    nextRoot = await tree.setEntry(
      nextRoot,
      parts,
      name,
      mutation.entry.cid,
      mutation.entry.size,
      mutation.entry.type,
      mutation.entry.meta,
    );
  } else if (mutation.type === 'delete') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('delete path is empty');
    const existing = await resolveEntry(tree, nextRoot, [...parts, name]);
    if (!existing) return nextRoot;
    deletedPaths.push(...await visiblePathsUnder(tree, nextRoot, [...parts, name]));
    roleOperations.push({ op: 'clear', path: mutation.path });
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
    let replacedTargetPaths = (await visiblePathsUnder(tree, nextRoot, targetPath))
      .filter((path) => !renamedSet.has(path));

    const target = await resolveEntry(tree, nextRoot, targetPath);
    if (target && target.type !== source.type) {
      replacedTargetPaths = replacedTargetPaths.filter((path) => path === mutation.to);
    }
    deletedPaths.push(...sourcePaths, ...replacedTargetPaths);
    roleOperations.push({ op: 'clear', path: mutation.to });
    roleOperations.push({ op: 'clear', path: mutation.from });
    if (target && target.type !== source.type) replacementPaths.push(mutation.to);
    if (target) nextRoot = await tree.removeEntry(nextRoot, toParts, toName);
    nextRoot = await tree.removeEntry(nextRoot, fromParts, fromName);
    const ensured = await ensureParentDirectories(tree, nextRoot, toParts);
    nextRoot = ensured.root;
    deletedPaths.push(...ensured.replacedFiles);
    replacementPaths.push(...ensured.replacedFiles);
    nextRoot = await tree.setEntry(
      nextRoot,
      toParts,
      toName,
      source.cid,
      source.size,
      source.type,
      source.meta,
    );
  }

  if (!recordTombstones) return nextRoot;
  return updateMutationMetadata(tree, nextRoot, {
    add: deletedPaths,
    replacementPaths,
    roleOperations,
    tombstonedAt: options.tombstonedAt,
  });
}

/**
 * Re-attach this AppKey's retained deletion barriers and path-kind roles to a
 * metadata-free logical root immediately before signing it. A local mutation
 * delta distinguishes an active kind replacement from delete-then-recreate.
 */
export async function prepareProfileDriveRootForPublish(
  tree: HashTree,
  root: CID,
  previousContribution?: CID | null,
): Promise<CID> {
  return (await prepareProfileDriveRootForPublishResult(
    tree,
    root,
    previousContribution,
  )).root;
}

export type PreparedProfileDriveRoot = {
  root: CID;
};

export async function prepareProfileDriveRootForPublishResult(
  tree: HashTree,
  root: CID,
  previousContribution?: CID | null,
): Promise<PreparedProfileDriveRoot> {
  const retained = previousContribution
    ? await readTombstoneTimestamps(tree, previousContribution)
    : new Map<string, number>();
  const current = await readTombstoneTimestamps(tree, root);
  let retainedMax = 0;
  for (const timestamp of retained.values()) retainedMax = Math.max(retainedMax, timestamp);
  const authoredPaths = await readAuthoredTombstonePaths(tree, root);
  for (const [path, timestamp] of current) {
    const previous = retained.get(path);
    if (previous === undefined || timestamp > previous) authoredPaths.add(path);
  }
  const generationRemap = new Map<number, number>();
  const authoredGenerations = [...new Set([...authoredPaths]
    .map((path) => current.get(path))
    .filter((value): value is number => value !== undefined))].sort((left, right) => left - right);
  for (const generation of authoredGenerations) {
    const next = generation > retainedMax ? generation : retainedMax + 1;
    generationRemap.set(generation, next);
    retainedMax = next;
  }
  for (const path of authoredPaths) {
    const generation = current.get(path);
    if (generation !== undefined) current.set(path, generationRemap.get(generation) ?? generation);
  }
  for (const [path, timestamp] of current) {
    retained.set(path, Math.max(retained.get(path) ?? 0, timestamp));
  }
  const currentRoles = await readPathKindReplacements(tree, root);
  const previousRoles = previousContribution
    ? await readPathKindReplacements(tree, previousContribution)
    : { present: false, roles: new Map<string, number>() };
  const delta = await readPathKindReplacementDelta(tree, root);
  let roles = delta
    ? new Map(delta.inheritPrevious
      ? [...previousRoles.roles, ...currentRoles.roles]
      : currentRoles.roles)
    : new Map(currentRoles.present ? currentRoles.roles : previousRoles.roles);
  if (delta) {
    const operations = delta.operations.map((operation) => (
      operation.op === 'set'
        ? { ...operation, generation: generationRemap.get(operation.generation) ?? operation.generation }
        : operation
    ));
    roles = applyPathKindReplacementOperations(roles, operations);
  }
  let prepared = await replaceTombstones(tree, root, retained);
  prepared = await replacePathKindReplacements(tree, prepared, roles);
  prepared = await replacePathKindReplacementDelta(tree, prepared, null);
  return { root: await replaceAuthoredTombstonePaths(tree, prepared, []) };
}

async function updateMutationMetadata(
  tree: HashTree,
  root: CID,
  options: {
    add: string[];
    replacementPaths: string[];
    roleOperations: PathKindReplacementOperation[];
    tombstonedAt?: number;
  },
): Promise<CID> {
  const tombstones = await readTombstoneTimestamps(tree, root);
  const roles = await readPathKindReplacements(tree, root);
  const previousDelta = await readPathKindReplacementDelta(tree, root);
  let newestRetained = 0;
  for (const value of tombstones.values()) newestRetained = Math.max(newestRetained, value);
  for (const value of roles.roles.values()) newestRetained = Math.max(newestRetained, value);
  for (const operation of previousDelta?.operations ?? []) {
    if (operation.op === 'set') newestRetained = Math.max(newestRetained, operation.generation);
  }
  const requestedGeneration = options.tombstonedAt ?? Math.floor(Date.now() / 1000);
  const tombstonedAt = Math.max(requestedGeneration, newestRetained + 1);
  const authored = await readAuthoredTombstonePaths(tree, root);
  for (const path of options.add) {
    if (path && !path.startsWith(`${META_DIRECTORY}/`)) {
      tombstones.set(path, Math.max(tombstones.get(path) ?? 0, tombstonedAt));
      authored.add(path);
    }
  }
  const operations = [...(previousDelta?.operations ?? []), ...options.roleOperations];
  for (const path of new Set(options.replacementPaths)) {
    operations.push({ op: 'set', path, generation: tombstonedAt });
  }
  let updated = await replaceTombstones(tree, root, tombstones);
  updated = await replaceAuthoredTombstonePaths(tree, updated, authored);
  return replacePathKindReplacementDelta(tree, updated, {
    inheritPrevious: previousDelta?.inheritPrevious ?? !roles.present,
    operations,
  });
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

async function readAuthoredTombstonePaths(tree: HashTree, root: CID): Promise<Set<string>> {
  const marker = await resolveEntry(tree, root, [META_DIRECTORY, AUTHORED_TOMBSTONES_FILE]);
  if (!marker || marker.type === LinkType.Dir) return new Set();
  const raw = await tree.readFile(marker.cid);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((path): path is string => (
      typeof path === 'string' && path.length > 0 && !path.startsWith(`${META_DIRECTORY}/`)
    )));
  } catch {
    return new Set();
  }
}

async function replaceAuthoredTombstonePaths(
  tree: HashTree,
  root: CID,
  paths: ReadonlySet<string> | readonly string[],
): Promise<CID> {
  const metadata = await resolveEntry(tree, root, [META_DIRECTORY]);
  let metadataRoot = metadata?.type === LinkType.Dir
    ? metadata.cid
    : (await tree.putDirectory([])).cid;
  if (metadata && metadata.type !== LinkType.Dir) {
    root = await tree.removeEntry(root, [], META_DIRECTORY);
  }
  const existing = await resolveEntry(tree, metadataRoot, [AUTHORED_TOMBSTONES_FILE]);
  if (existing) {
    metadataRoot = await tree.removeEntry(metadataRoot, [], AUTHORED_TOMBSTONES_FILE);
  }
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length > 0) {
    const marker = await tree.putFile(new TextEncoder().encode(JSON.stringify(uniquePaths)));
    metadataRoot = await tree.setEntry(
      metadataRoot,
      [],
      AUTHORED_TOMBSTONES_FILE,
      marker.cid,
      marker.size,
      LinkType.Blob,
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
    ? await tree.resolvePath(root, parentParts)
    : { cid: root, type: LinkType.Dir };
  if (!parent?.cid || parent.type !== LinkType.Dir) return null;
  const entries = await tree.listDirectory(parent.cid);
  return entries.find((entry) => entry.name === name) ?? null;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}
