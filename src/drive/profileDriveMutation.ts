import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import {
  applyPathKindReplacementOperations,
  cidCacheKey,
  encodePathKindReplacementDelta,
  encodePathKindReplacements,
  PATH_KIND_REPLACEMENT_DELTA_FILE,
  PATH_KIND_REPLACEMENTS_FILE,
  PROFILE_DRIVE_METADATA_DIRECTORY,
  readMetadataEntries,
  readPathKindReplacementDeltaEntry,
  readPathKindReplacementsEntry,
  sameCid,
  writeMetadataEntries,
  type PathKindReplacementOperation,
} from './profileDrivePathKindMetadata';
import { withoutReturnRequest } from './fileOwnershipMetadata';
import { moveEntriesInTree, type MoveResult } from '../lib/moveEntries';

const META_DIRECTORY = PROFILE_DRIVE_METADATA_DIRECTORY;
const TOMBSTONE_DIRECTORY = 'tombstones';
const AUTHORED_TOMBSTONES_FILE = 'authored-tombstones.json';
const WALK_CONCURRENCY = 8;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export type ProfileDriveMutation =
  | { type: 'write'; path: string; content: string | Uint8Array }
  | { type: 'mkdir'; path: string }
  | { type: 'set-entry'; path: string; entry: Omit<TreeEntry, 'name'> }
  /** `markContents: false` records one marker for a folder instead of one per file below it. */
  | { type: 'delete'; path: string; markContents?: boolean }
  | { type: 'rename'; from: string; to: string };

export interface ProfileDriveMutationOptions {
  recordTombstones?: boolean;
  tombstonedAt?: number;
}

export interface TreeEntryWrite {
  path: string[];
  entry: Omit<TreeEntry, 'name'>;
  /** When true, an existing directory at `path` is kept untouched instead of replaced. */
  ensureDir?: boolean;
}

/** Run async work with at most `limit` concurrent operations. */
export function createLimiter(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Move a selection together, recording its deletion barriers in one metadata update. */
export async function moveProfileDriveEntries(
  tree: HashTree,
  root: CID,
  sourcePath: string[],
  names: string[],
  targetPath: string[],
  expected?: ReadonlyMap<string, string>,
): Promise<MoveResult> {
  const move = await moveEntriesInTree(tree, root, sourcePath, names, targetPath, expected);
  if (!move.items.length) return move;
  const pathLists = await Promise.all(move.items.map(({ entry }) => (
    visibleEntryPathsUnder(tree, entry, [...sourcePath, entry.name])
  )));
  const deletedPaths = pathLists.flat();
  const roleOperations: PathKindReplacementOperation[] = [];
  for (const { entry, destinationName } of move.items) {
    roleOperations.push({ op: 'clear', path: [...sourcePath, entry.name].join('/') });
    roleOperations.push({ op: 'clear', path: [...targetPath, destinationName].join('/') });
  }
  const updated = await updateMutationMetadata(tree, move.root, { add: deletedPaths, replacementPaths: [], roleOperations });
  return { root: updated, items: move.items };
}

/** Remove multiple entries from one folder in a single directory-chain rewrite. */
export async function deleteEntriesInFolder(
  tree: HashTree,
  root: CID,
  parentPath: string[],
  names: readonly string[],
): Promise<{ root: CID; removed: TreeEntry[] }> {
  const targets = new Set(names);
  if (targets.size === 0) return { root, removed: [] };

  const chain: Array<{ name: string; entries: TreeEntry[]; unencrypted: boolean }> = [];
  let dirCid = root;
  for (const segment of parentPath) {
    const entries = await tree.listDirectory(dirCid);
    const child = entries.find((entry) => entry.name === segment);
    if (!child || child.type !== LinkType.Dir) return { root, removed: [] };
    chain.push({ name: segment, entries, unencrypted: !dirCid.key });
    dirCid = child.cid;
  }

  const folderEntries = await tree.listDirectory(dirCid);
  const removed = folderEntries.filter((entry) => targets.has(entry.name));
  if (removed.length === 0) return { root, removed: [] };

  let rebuilt = await tree.putDirectory(
    folderEntries.filter((entry) => !targets.has(entry.name)),
    { unencrypted: !dirCid.key },
  );
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const level = chain[i]!;
    const updated = level.entries.map((entry) => (
      entry.name === level.name ? { ...entry, cid: rebuilt.cid, size: rebuilt.size } : entry
    ));
    rebuilt = await tree.putDirectory(updated, { unencrypted: level.unencrypted });
  }
  return { root: rebuilt.cid, removed };
}

/** Delete multiple entries from one folder with a single tree rewrite and one metadata update. */
export async function deleteProfileDriveEntries(
  tree: HashTree,
  root: CID,
  parentPath: string[],
  names: readonly string[],
  options: ProfileDriveMutationOptions & { markContents?: boolean } = {},
): Promise<CID> {
  const { root: nextRoot, removed } = await deleteEntriesInFolder(tree, root, parentPath, names);
  if (removed.length === 0 || options.recordTombstones === false) return nextRoot;

  // A marker on a folder already covers everything below it when roots are merged.
  const deletedPaths = options.markContents === false
    ? removed.map((entry) => [...parentPath, entry.name].join('/'))
    : (await Promise.all(removed.map((entry) => (
      visibleEntryPathsUnder(tree, entry, [...parentPath, entry.name])
    )))).flat();
  const roleOperations: PathKindReplacementOperation[] = removed.map((entry) => ({
    op: 'clear',
    path: [...parentPath, entry.name].join('/'),
  }));
  return updateMutationMetadata(tree, nextRoot, {
    add: deletedPaths,
    replacementPaths: [],
    roleOperations,
    tombstonedAt: options.tombstonedAt,
  });
}

type WriteNode = {
  children: Map<string, WriteNode>;
  leaf?: { entry: Omit<TreeEntry, 'name'>; ensureDir?: boolean };
  path: string[];
};

/**
 * Apply multiple entry writes (flat or nested) bottom-up so every affected
 * directory is read and stored at most once.
 */
export async function spliceEntriesInTree(
  tree: HashTree,
  root: CID,
  writes: readonly TreeEntryWrite[],
): Promise<{
  root: CID;
  changed: boolean;
  deletedPaths: string[];
  replacementPaths: string[];
  roleOperations: PathKindReplacementOperation[];
}> {
  const trie: WriteNode = { children: new Map(), path: [] };
  for (const write of writes) {
    const parts = write.path.flatMap((part) => part.split('/')).filter(Boolean);
    if (parts.length === 0) throw new Error('write path is empty');
    let node = trie;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (i > 0 && node.leaf && node.leaf.entry.type !== LinkType.Dir) {
        node.leaf = undefined;
      }
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), path: parts.slice(0, i + 1) };
        node.children.set(part, child);
      }
      node = child;
    }
    if (write.ensureDir && write.entry.type === LinkType.Dir && node.children.size > 0) {
      node.leaf ??= { entry: write.entry, ensureDir: true };
    } else {
      node.children.clear();
      node.leaf = { entry: write.entry, ensureDir: write.ensureDir };
    }
  }

  const deletedPaths: string[] = [];
  const replacementPaths: string[] = [];
  const roleOperations: PathKindReplacementOperation[] = [];
  const limit = createLimiter(WALK_CONCURRENCY);

  const apply = async (dirCid: CID | null, node: WriteNode): Promise<{ cid: CID; size: number; changed: boolean }> => {
    const existingList = dirCid ? await limit(() => tree.listDirectory(dirCid)) : [];
    const byName = new Map(existingList.map((entry) => [entry.name, entry]));
    const unencrypted = dirCid ? !dirCid.key : false;
    let changed = dirCid === null;

    await Promise.all([...node.children.entries()].map(async ([name, child]) => {
      const existing = byName.get(name);
      const pathStr = child.path.join('/');
      if (child.leaf && child.children.size === 0) {
        const { entry, ensureDir } = child.leaf;
        if (ensureDir && entry.type === LinkType.Dir && existing?.type === LinkType.Dir) return;
        if (existing && existing.type !== entry.type) {
          deletedPaths.push(pathStr);
          replacementPaths.push(pathStr);
        } else if (!existing) {
          roleOperations.push({ op: 'clear', path: pathStr });
        }
        byName.set(name, {
          name,
          cid: entry.cid,
          size: entry.size,
          type: entry.type,
          ...(entry.meta !== undefined ? { meta: entry.meta } : {}),
        });
        changed = true;
        return;
      }

      let subCid: CID | null = existing?.type === LinkType.Dir ? existing.cid : null;
      if (existing && existing.type !== LinkType.Dir) {
        deletedPaths.push(pathStr);
        replacementPaths.push(pathStr);
        subCid = null;
      }
      const sub = await apply(subCid, child);
      if (sub.changed || existing?.type !== LinkType.Dir) {
        byName.set(name, {
          name,
          cid: sub.cid,
          size: 0,
          type: LinkType.Dir,
          meta: child.leaf?.entry.meta ?? (existing?.type === LinkType.Dir ? existing.meta : undefined),
        });
        changed = true;
      }
    }));

    if (!changed && dirCid) return { cid: dirCid, size: 0, changed: false };
    const put = await limit(() => tree.putDirectory([...byName.values()], { unencrypted }));
    return { cid: put.cid, size: put.size, changed: true };
  };

  if (trie.children.size === 0) {
    return { root, changed: false, deletedPaths, replacementPaths, roleOperations };
  }
  const result = await apply(root, trie);
  return { root: result.cid, changed: result.changed, deletedPaths, replacementPaths, roleOperations };
}

/** Apply multiple entry writes to a profile Drive with a single tree splice and one metadata update. */
export async function setProfileDriveEntries(
  tree: HashTree,
  root: CID,
  writes: readonly TreeEntryWrite[],
  options: ProfileDriveMutationOptions = {},
): Promise<CID> {
  const spliced = await spliceEntriesInTree(tree, root, writes);
  if (!spliced.changed || options.recordTombstones === false) return spliced.root;
  return updateMutationMetadata(tree, spliced.root, {
    add: spliced.deletedPaths,
    replacementPaths: spliced.replacementPaths,
    roleOperations: spliced.roleOperations,
    tombstonedAt: options.tombstonedAt,
  });
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
  if (mutation.type === 'write') {
    const parts = splitPath(mutation.path);
    if (parts.length === 0) throw new Error('write path is empty');
    const data = typeof mutation.content === 'string'
      ? utf8Encoder.encode(mutation.content)
      : mutation.content;
    const file = await tree.putFile(data);
    return setProfileDriveEntries(
      tree,
      root,
      [{ path: parts, entry: { cid: file.cid, size: file.size, type: LinkType.Blob } }],
      options,
    );
  }
  if (mutation.type === 'mkdir') {
    const parts = splitPath(mutation.path);
    if (parts.length === 0) throw new Error('mkdir path is empty');
    const existing = await resolveEntry(tree, root, parts);
    if (existing?.type === LinkType.Dir) return root;
    const empty = await tree.putDirectory([]);
    return setProfileDriveEntries(
      tree,
      root,
      [{ path: parts, entry: { cid: empty.cid, size: 0, type: LinkType.Dir }, ensureDir: true }],
      options,
    );
  }
  if (mutation.type === 'set-entry') {
    const parts = splitPath(mutation.path);
    if (parts.length === 0) throw new Error('set-entry path is empty');
    return setProfileDriveEntries(tree, root, [{ path: parts, entry: mutation.entry }], options);
  }
  if (mutation.type === 'delete') {
    const parts = splitPath(mutation.path);
    const name = parts.pop();
    if (!name) throw new Error('delete path is empty');
    return deleteProfileDriveEntries(tree, root, parts, [name], {
      ...options,
      markContents: mutation.markContents,
    });
  }

  // rename
  const fromParts = splitPath(mutation.from);
  const toParts = splitPath(mutation.to);
  const fromName = fromParts.pop();
  const toName = toParts.pop();
  if (!fromName || !toName) throw new Error('rename path is empty');

  const sourcePath = [...fromParts, fromName];
  const targetPath = [...toParts, toName];
  const [source, target] = await Promise.all([
    resolveEntry(tree, root, sourcePath),
    resolveEntry(tree, root, targetPath),
  ]);
  if (!source) throw new Error(`rename source missing: ${mutation.from}`);
  const [sourcePaths, targetPaths] = await Promise.all([
    visibleEntryPathsUnder(tree, source, sourcePath),
    target ? visibleEntryPathsUnder(tree, target, targetPath) : Promise.resolve([] as string[]),
  ]);
  const renamedSet = new Set(sourcePaths.map((path) => (
    path === mutation.from ? mutation.to : `${mutation.to}/${path.slice(mutation.from.length + 1)}`
  )));
  let replacedTargetPaths = targetPaths.filter((path) => !renamedSet.has(path));
  if (target && target.type !== source.type) {
    replacedTargetPaths = replacedTargetPaths.filter((path) => path === mutation.to);
  }

  const deletedPaths = [...sourcePaths, ...replacedTargetPaths];
  const replacementPaths = target && target.type !== source.type ? [mutation.to] : [];
  const roleOperations: PathKindReplacementOperation[] = [
    { op: 'clear', path: mutation.to },
    { op: 'clear', path: mutation.from },
  ];

  let nextRoot = root;
  if (target) nextRoot = await tree.removeEntry(nextRoot, toParts, toName);
  nextRoot = await tree.removeEntry(nextRoot, fromParts, fromName);
  const spliced = await spliceEntriesInTree(tree, nextRoot, [{
    path: targetPath,
    entry: {
      cid: source.cid,
      size: source.size,
      type: source.type,
      meta: withoutReturnRequest(source.meta),
    },
  }]);
  nextRoot = spliced.root;
  deletedPaths.push(...spliced.deletedPaths);
  replacementPaths.push(...spliced.replacementPaths);

  if (options.recordTombstones === false) return nextRoot;
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
  const [meta, prevMeta] = await Promise.all([
    readMetadataEntries(tree, root),
    previousContribution ? readMetadataEntries(tree, previousContribution) : Promise.resolve(null),
  ]);
  const [currentRoles, previousRoles, delta, authoredPaths] = await Promise.all([
    readPathKindReplacementsEntry(tree, meta.entries.get(PATH_KIND_REPLACEMENTS_FILE)),
    prevMeta
      ? readPathKindReplacementsEntry(tree, prevMeta.entries.get(PATH_KIND_REPLACEMENTS_FILE))
      : Promise.resolve({ present: false, roles: new Map<string, number>() }),
    readPathKindReplacementDeltaEntry(tree, meta.entries.get(PATH_KIND_REPLACEMENT_DELTA_FILE)),
    readAuthoredTombstonePathsEntry(tree, meta.entries.get(AUTHORED_TOMBSTONES_FILE)),
  ]);

  const rawCurrTomb = meta.entries.get(TOMBSTONE_DIRECTORY);
  const currTomb = rawCurrTomb?.type === LinkType.Dir ? rawCurrTomb : null;
  const rawPrevTomb = prevMeta?.entries.get(TOMBSTONE_DIRECTORY);
  const prevTomb = rawPrevTomb?.type === LinkType.Dir ? rawPrevTomb : null;
  const hasDeltaSet = delta?.operations.some((op) => op.op === 'set') ?? false;

  const generationRemap = new Map<number, number>();
  let nextTombEntry: TreeEntry | null;

  // Fast path: no new tombstones were authored since `previousContribution`,
  // so reuse the immutable tombstone directory CID directly without walking it.
  if (authoredPaths.size === 0 && !hasDeltaSet && (!currTomb || (prevTomb && sameCid(currTomb.cid, prevTomb.cid)))) {
    nextTombEntry = prevTomb;
  } else {
    const [retained, current] = await Promise.all([
      prevTomb ? readTombstoneDirectory(tree, prevTomb.cid) : Promise.resolve(new Map<string, number>()),
      currTomb ? readTombstoneDirectory(tree, currTomb.cid) : Promise.resolve(new Map<string, number>()),
    ]);
    const originalRetainedSize = retained.size;
    let retainedChanged = false;
    let retainedMax = 0;
    for (const timestamp of retained.values()) retainedMax = Math.max(retainedMax, timestamp);
    for (const [path, timestamp] of current) {
      const previous = retained.get(path);
      if (previous === undefined || timestamp > previous) authoredPaths.add(path);
    }
    const authoredGenerations = [...new Set([...authoredPaths]
      .map((path) => current.get(path))
      .filter((value): value is number => value !== undefined))].sort((left, right) => left - right);
    let remapped = false;
    for (const generation of authoredGenerations) {
      const next = generation > retainedMax ? generation : retainedMax + 1;
      if (next !== generation) remapped = true;
      generationRemap.set(generation, next);
      retainedMax = next;
    }
    if (remapped) {
      for (const path of authoredPaths) {
        const generation = current.get(path);
        if (generation !== undefined) current.set(path, generationRemap.get(generation) ?? generation);
      }
    }
    for (const [path, timestamp] of current) {
      const merged = Math.max(retained.get(path) ?? 0, timestamp);
      if (retained.get(path) !== merged) {
        retained.set(path, merged);
        retainedChanged = true;
      }
    }

    if (retained.size === 0) {
      nextTombEntry = null;
    } else if (prevTomb && !retainedChanged && retained.size === originalRetainedSize) {
      nextTombEntry = prevTomb;
    } else if (currTomb && !remapped && originalRetainedSize === 0) {
      nextTombEntry = currTomb;
    } else {
      nextTombEntry = {
        name: TOMBSTONE_DIRECTORY,
        cid: await buildTombstoneDirectory(tree, retained),
        size: 0,
        type: LinkType.Dir,
      };
    }
  }

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

  let nextRolesEntry: TreeEntry;
  if (currentRoles.present && mapsEqual(roles, currentRoles.roles)) {
    nextRolesEntry = meta.entries.get(PATH_KIND_REPLACEMENTS_FILE)!;
  } else if (previousRoles.present && mapsEqual(roles, previousRoles.roles)) {
    nextRolesEntry = prevMeta!.entries.get(PATH_KIND_REPLACEMENTS_FILE)!;
  } else {
    const encoded = await tree.putFile(encodePathKindReplacements(roles));
    nextRolesEntry = {
      name: PATH_KIND_REPLACEMENTS_FILE,
      cid: encoded.cid,
      size: encoded.size,
      type: LinkType.Blob,
    };
  }

  const prepared = await writeMetadataEntries(tree, root, meta, {
    [TOMBSTONE_DIRECTORY]: nextTombEntry,
    [PATH_KIND_REPLACEMENTS_FILE]: nextRolesEntry,
    [PATH_KIND_REPLACEMENT_DELTA_FILE]: null,
    [AUTHORED_TOMBSTONES_FILE]: null,
  });
  return { root: prepared };
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
  const validAdds = options.add.filter((path) => path && !path.startsWith(`${META_DIRECTORY}/`));
  const hasTombstoneWork = validAdds.length > 0 || options.replacementPaths.length > 0;

  // Common path (plain overwrites, uploads, creates): skip reading and rebuilding tombstones.
  if (!hasTombstoneWork && options.roleOperations.length === 0) return root;

  const meta = await readMetadataEntries(tree, root);
  if (!hasTombstoneWork) {
    const rolesEntry = meta.entries.get(PATH_KIND_REPLACEMENTS_FILE);
    if (rolesEntry?.type === LinkType.Dir) throw new Error('path-kind replacement metadata must be a file');
    const previousDelta = await readPathKindReplacementDeltaEntry(
      tree,
      meta.entries.get(PATH_KIND_REPLACEMENT_DELTA_FILE),
    );
    if (rolesEntry && !previousDelta) {
      const { roles } = await readPathKindReplacementsEntry(tree, rolesEntry);
      const affectsRoles = options.roleOperations.some((op) => op.op === 'set' || rolesHasPathOrDescendant(roles, op.path));
      if (!affectsRoles) return root;
    }
    const operations = appendRoleOperations(previousDelta?.operations ?? [], options.roleOperations);
    if (previousDelta && operations.length === previousDelta.operations.length) return root;
    const deltaFile = await tree.putFile(encodePathKindReplacementDelta({
      inheritPrevious: previousDelta?.inheritPrevious ?? !rolesEntry,
      operations,
    }));
    return writeMetadataEntries(tree, root, meta, {
      [PATH_KIND_REPLACEMENT_DELTA_FILE]: {
        name: PATH_KIND_REPLACEMENT_DELTA_FILE,
        cid: deltaFile.cid,
        size: deltaFile.size,
        type: LinkType.Blob,
      },
    });
  }

  const rawTomb = meta.entries.get(TOMBSTONE_DIRECTORY);
  const tombDir = rawTomb?.type === LinkType.Dir ? rawTomb : null;
  const [tombstones, roles, previousDelta, authored] = await Promise.all([
    tombDir ? readTombstoneDirectory(tree, tombDir.cid) : Promise.resolve(new Map<string, number>()),
    readPathKindReplacementsEntry(tree, meta.entries.get(PATH_KIND_REPLACEMENTS_FILE)),
    readPathKindReplacementDeltaEntry(tree, meta.entries.get(PATH_KIND_REPLACEMENT_DELTA_FILE)),
    readAuthoredTombstonePathsEntry(tree, meta.entries.get(AUTHORED_TOMBSTONES_FILE)),
  ]);

  let newestRetained = 0;
  for (const value of tombstones.values()) newestRetained = Math.max(newestRetained, value);
  for (const value of roles.roles.values()) newestRetained = Math.max(newestRetained, value);
  for (const operation of previousDelta?.operations ?? []) {
    if (operation.op === 'set') newestRetained = Math.max(newestRetained, operation.generation);
  }
  const requestedGeneration = options.tombstonedAt ?? Math.floor(Date.now() / 1000);
  const tombstonedAt = Math.max(requestedGeneration, newestRetained + 1);

  for (const path of validAdds) {
    tombstones.set(path, Math.max(tombstones.get(path) ?? 0, tombstonedAt));
    authored.add(path);
  }
  const operations = appendRoleOperations(previousDelta?.operations ?? [], [
    ...options.roleOperations,
    ...[...new Set(options.replacementPaths)].map((path): PathKindReplacementOperation => ({
      op: 'set',
      path,
      generation: tombstonedAt,
    })),
  ]);

  const uniqueAuthored = [...authored].sort();
  const [tombstoneCid, authoredFile, deltaFile] = await Promise.all([
    tombstones.size > 0 ? buildTombstoneDirectory(tree, tombstones) : Promise.resolve(null),
    uniqueAuthored.length > 0
      ? tree.putFile(utf8Encoder.encode(JSON.stringify(uniqueAuthored)))
      : Promise.resolve(null),
    tree.putFile(encodePathKindReplacementDelta({
      inheritPrevious: previousDelta?.inheritPrevious ?? !roles.present,
      operations,
    })),
  ]);

  return writeMetadataEntries(tree, root, meta, {
    [TOMBSTONE_DIRECTORY]: tombstoneCid
      ? { name: TOMBSTONE_DIRECTORY, cid: tombstoneCid, size: 0, type: LinkType.Dir }
      : null,
    [AUTHORED_TOMBSTONES_FILE]: authoredFile
      ? { name: AUTHORED_TOMBSTONES_FILE, cid: authoredFile.cid, size: authoredFile.size, type: LinkType.Blob }
      : null,
    [PATH_KIND_REPLACEMENT_DELTA_FILE]: {
      name: PATH_KIND_REPLACEMENT_DELTA_FILE,
      cid: deltaFile.cid,
      size: deltaFile.size,
      type: LinkType.Blob,
    },
  });
}

/** Append role operations while skipping redundant duplicate trailing clears. */
function appendRoleOperations(
  existing: readonly PathKindReplacementOperation[],
  added: readonly PathKindReplacementOperation[],
): PathKindReplacementOperation[] {
  const result = existing.slice();
  const clearedSinceSet = new Set<string>();
  for (const op of result) {
    if (op.op === 'set') clearedSinceSet.clear();
    else clearedSinceSet.add(op.path);
  }
  for (const op of added) {
    if (op.op === 'set') {
      clearedSinceSet.clear();
      result.push(op);
    } else if (!clearedSinceSet.has(op.path)) {
      clearedSinceSet.add(op.path);
      result.push(op);
    }
  }
  return result;
}

function rolesHasPathOrDescendant(roles: ReadonlyMap<string, number>, path: string): boolean {
  if (roles.size === 0) return false;
  if (roles.has(path)) return true;
  const prefix = `${path}/`;
  for (const key of roles.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function mapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function readAuthoredTombstonePathsEntry(
  tree: HashTree,
  marker: TreeEntry | undefined,
): Promise<Set<string>> {
  if (!marker || marker.type === LinkType.Dir) return new Set();
  const raw = await tree.readFile(marker.cid);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(utf8Decoder.decode(raw));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((path): path is string => (
      typeof path === 'string' && path.length > 0 && !path.startsWith(`${META_DIRECTORY}/`)
    )));
  } catch {
    return new Set();
  }
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
  for (const [path, timestamp] of tombstones) {
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

  // A deleted folder marks every path below it with the same timestamp.
  const limit = createLimiter(WALK_CONCURRENCY);
  const markers = new Map<number, Promise<{ cid: CID; size: number }>>();
  const markerFor = (timestamp: number) => {
    let marker = markers.get(timestamp);
    if (!marker) {
      marker = limit(() => tree.putFile(utf8Encoder.encode(String(timestamp))));
      markers.set(timestamp, marker);
    }
    return marker;
  };

  const materialize = async (node: TombstoneTrie): Promise<CID> => {
    const [dirEntries, markerEntries] = await Promise.all([
      Promise.all([...node.directories].map(async ([name, child]): Promise<TreeEntry> => ({
        name,
        cid: await materialize(child),
        size: 0,
        type: LinkType.Dir,
      }))),
      Promise.all([...node.markers].map(async ([name, timestamp]): Promise<TreeEntry> => {
        const marker = await markerFor(timestamp);
        return { name, cid: marker.cid, size: marker.size, type: LinkType.Blob };
      })),
    ]);
    const entries = [...dirEntries, ...markerEntries].sort((left, right) => left.name.localeCompare(right.name));
    return (await limit(() => tree.putDirectory(entries))).cid;
  };
  return materialize(trie);
}

/**
 * Read every tombstone path -> timestamp under a `.hashtree/tombstones` directory.
 * Deduplicates timestamp blob reads by CID hash because a deleted folder shares
 * one identical timestamp blob across every deleted descendant.
 */
export async function readTombstoneDirectory(
  tree: HashTree,
  tombstoneDir: CID,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const limit = createLimiter(WALK_CONCURRENCY);
  const timestampByCid = new Map<string, Promise<number | null>>();

  const readTimestamp = (cid: CID): Promise<number | null> => {
    const key = cidCacheKey(cid);
    let pending = timestampByCid.get(key);
    if (!pending) {
      pending = limit(async () => {
        signal?.throwIfAborted();
        const raw = await tree.readFile(cid);
        if (!raw) return null;
        const timestamp = Number(utf8Decoder.decode(raw).trim());
        return Number.isSafeInteger(timestamp) ? timestamp : null;
      });
      timestampByCid.set(key, pending);
    }
    return pending;
  };

  const walk = async (directory: CID, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await limit(() => tree.listDirectory(directory, signal));
    await Promise.all(entries.map(async (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === LinkType.Dir) {
        await walk(entry.cid, path);
        return;
      }
      const timestamp = await readTimestamp(entry.cid);
      if (timestamp !== null) out.set(path, timestamp);
    }));
  };

  await walk(tombstoneDir, '');
  return out;
}

async function visibleEntryPathsUnder(tree: HashTree, entry: TreeEntry, targetParts: string[]): Promise<string[]> {
  if (targetParts[0] === META_DIRECTORY) return [];
  const targetPath = targetParts.join('/');
  if (entry.type !== LinkType.Dir) return [targetPath];

  const paths: string[] = [targetPath];
  const limit = createLimiter(WALK_CONCURRENCY);
  const walk = async (directory: CID, prefix: string): Promise<void> => {
    const children = await limit(() => tree.listDirectory(directory));
    const subdirs: Array<{ cid: CID; path: string }> = [];
    for (const child of children) {
      const childPath = `${prefix}/${child.name}`;
      paths.push(childPath);
      if (child.type === LinkType.Dir) subdirs.push({ cid: child.cid, path: childPath });
    }
    await Promise.all(subdirs.map(({ cid, path }) => walk(cid, path)));
  };
  await walk(entry.cid, targetPath);
  return paths;
}

export async function resolveEntry(
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
