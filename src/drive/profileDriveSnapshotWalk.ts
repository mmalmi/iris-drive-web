import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import {
  cidCacheKey,
  decodePathKindReplacements,
  PATH_KIND_REPLACEMENTS_FILE,
  sameCid,
} from './profileDrivePathKindMetadata';
import { createLimiter, readTombstoneDirectory } from './profileDriveMutation';
import type {
  ProfileDriveRootCandidate,
  ProfileDriveSnapshot,
  SnapshotDirectory,
  SnapshotFile,
} from './profileDriveProjection';

export const META_DIR = '.hashtree';
const TOMBSTONES_DIR = 'tombstones';
const IGNORED_NAMES = new Set(['.ds_store', '.hashtree', '.trash', '$recycle.bin', 'thumbs.db', 'desktop.ini']);
const WALK_CONCURRENCY = 8;
const MAX_CACHED_ROOTS = 64;
const MAX_CACHED_SUBTREES = 1024;

type ParsedSubtree = {
  files: Array<{ path: string; entry: TreeEntry }>;
  directories: Array<{ path: string; entry: TreeEntry; hasIgnored: boolean }>;
  hasIgnored: boolean;
};

export type ParsedRootTree = ParsedSubtree & {
  tombstones: Array<{ path: string; tombstonedAt: number }>;
  pathKindReplacements: ReadonlyMap<string, number>;
  pathKindMetadataPresent: boolean;
  returnDirectory?: CID;
  topEntries: TreeEntry[];
  hasTopMeta: boolean;
};

export type WalkedRoot = {
  snapshot: ProfileDriveSnapshot;
  parsed: ParsedRootTree;
};

const treeCaches = new WeakMap<HashTree, { roots: Map<string, ParsedRootTree>; subtrees: Map<string, ParsedSubtree> }>();

function getTreeCache(tree: HashTree) {
  let cache = treeCaches.get(tree);
  if (!cache) treeCaches.set(tree, (cache = { roots: new Map(), subtrees: new Map() }));
  return cache;
}

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function lruSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function shouldIgnoreName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_NAMES.has(lower) || name.startsWith('._') || lower.startsWith('.trash-')
    || name.endsWith('~') || (name.startsWith('#') && name.endsWith('#')) || lower.endsWith('.sbak');
}

export function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function comparePathsByDepth(left: string, right: string): number {
  return splitPath(left).length - splitPath(right).length || left.localeCompare(right);
}

function forEachAncestor(path: string, visit: (ancestor: string) => boolean | void): boolean {
  let slash = path.indexOf('/');
  while (slash > 0) {
    if (visit(path.slice(0, slash)) === true) return true;
    slash = path.indexOf('/', slash + 1);
  }
  return false;
}

export function hasAncestorIn(path: string, ancestors: { has(key: string): boolean; size: number }): boolean {
  return ancestors.size > 0 && forEachAncestor(path, (ancestor) => ancestors.has(ancestor));
}

function appendChildren(target: ParsedSubtree, children: Array<{ entry: TreeEntry; sub: ParsedSubtree }>): void {
  for (const { entry, sub } of children) {
    if (sub.hasIgnored) target.hasIgnored = true;
    target.directories.push({ path: entry.name, entry, hasIgnored: sub.hasIgnored });
    for (const dir of sub.directories) {
      target.directories.push({ path: `${entry.name}/${dir.path}`, entry: dir.entry, hasIgnored: dir.hasIgnored });
    }
    for (const file of sub.files) {
      target.files.push({ path: `${entry.name}/${file.path}`, entry: file.entry });
    }
  }
}

async function walkVisibleSubtree(
  tree: HashTree,
  directory: CID,
  cache: ReturnType<typeof getTreeCache>,
  limit: ReturnType<typeof createLimiter>,
  signal?: AbortSignal,
): Promise<ParsedSubtree> {
  const key = cidCacheKey(directory);
  const cached = lruGet(cache.subtrees, key);
  if (cached) return cached;

  signal?.throwIfAborted();
  const entries = await limit(() => tree.listDirectory(directory, signal));
  const parsed: ParsedSubtree = { files: [], directories: [], hasIgnored: false };
  const subdirs: TreeEntry[] = [];
  for (const entry of entries) {
    if (shouldIgnoreName(entry.name)) parsed.hasIgnored = true;
    else if (entry.type === LinkType.Dir) subdirs.push(entry);
    else parsed.files.push({ path: entry.name, entry });
  }
  const children = await Promise.all(subdirs.map(async (entry) => ({
    entry,
    sub: await walkVisibleSubtree(tree, entry.cid, cache, limit, signal),
  })));
  appendChildren(parsed, children);
  lruSet(cache.subtrees, key, parsed, MAX_CACHED_SUBTREES);
  return parsed;
}

async function readMetadataSnapshot(tree: HashTree, directory: CID, signal?: AbortSignal) {
  const entries = await tree.listDirectory(directory, signal);
  const returnDirectory = entries.find((e) => e.name === 'file-returns-v1' && e.type === LinkType.Dir)?.cid;
  const tombstonesEntry = entries.find((e) => e.name === TOMBSTONES_DIR && e.type === LinkType.Dir);
  const replacements = entries.find((e) => e.name === PATH_KIND_REPLACEMENTS_FILE);
  if (replacements?.type === LinkType.Dir) throw new Error('path-kind replacement metadata must be a file');

  const [tombstoneMap, replacementRaw] = await Promise.all([
    tombstonesEntry ? readTombstoneDirectory(tree, tombstonesEntry.cid, signal) : Promise.resolve(new Map<string, number>()),
    replacements ? tree.readFile(replacements.cid) : Promise.resolve(null),
  ]);
  if (replacements && !replacementRaw) throw new Error('path-kind replacement metadata is unavailable');
  return {
    tombstones: [...tombstoneMap].map(([path, tombstonedAt]) => ({ path, tombstonedAt })),
    pathKindReplacements: replacementRaw ? decodePathKindReplacements(replacementRaw) : new Map<string, number>(),
    pathKindMetadataPresent: Boolean(replacements),
    returnDirectory,
  };
}

export async function walkProfileDriveRoot(
  tree: HashTree,
  source: ProfileDriveRootCandidate,
  signal?: AbortSignal,
): Promise<WalkedRoot> {
  const cache = getTreeCache(tree);
  const rootKey = cidCacheKey(source.parsed.root);
  let parsed = lruGet(cache.roots, rootKey);

  if (!parsed) {
    const limit = createLimiter(WALK_CONCURRENCY);
    signal?.throwIfAborted();
    const topEntries = await limit(() => tree.listDirectory(source.parsed.root, signal));
    const visible: ParsedSubtree = { files: [], directories: [], hasIgnored: false };
    const subdirs: TreeEntry[] = [];
    let metaDir: CID | null = null;
    let hasTopMeta = false;

    for (const entry of topEntries) {
      if (entry.name === META_DIR) {
        hasTopMeta = true;
        if (entry.type === LinkType.Dir) metaDir = entry.cid;
      } else if (shouldIgnoreName(entry.name)) {
        visible.hasIgnored = true;
      } else if (entry.type === LinkType.Dir) {
        subdirs.push(entry);
      } else {
        visible.files.push({ path: entry.name, entry });
      }
    }

    const [metaResult, children] = await Promise.all([
      metaDir ? readMetadataSnapshot(tree, metaDir, signal) : Promise.resolve(null),
      Promise.all(subdirs.map(async (entry) => ({
        entry,
        sub: await walkVisibleSubtree(tree, entry.cid, cache, limit, signal),
      }))),
    ]);
    appendChildren(visible, children);
    parsed = {
      ...visible,
      tombstones: metaResult?.tombstones ?? [],
      pathKindReplacements: metaResult?.pathKindReplacements ?? new Map(),
      pathKindMetadataPresent: metaResult?.pathKindMetadataPresent ?? false,
      returnDirectory: metaResult?.returnDirectory,
      topEntries,
      hasTopMeta,
    };
    lruSet(cache.roots, rootKey, parsed, MAX_CACHED_ROOTS);
  }

  return {
    parsed,
    snapshot: {
      files: parsed.files.map(({ path, entry }) => ({ path, entry, source })),
      directories: parsed.directories.map(({ path, entry }) => ({ path, entry, source })),
      tombstones: parsed.tombstones.map(({ path, tombstonedAt }) => ({ path, tombstonedAt, source })),
      pathKindReplacements: new Map(parsed.pathKindReplacements),
      pathKindMetadataPresent: parsed.pathKindMetadataPresent,
      returnDirectory: parsed.returnDirectory,
      source,
    },
  };
}

/**
 * Find merged directories whose immutable CID can be linked straight into the
 * output without rewriting any descendant directory.
 */
export function findPassthroughDirectories(
  walked: readonly WalkedRoot[],
  mergedDirectories: ReadonlyMap<string, SnapshotDirectory>,
  mergedFiles: readonly SnapshotFile[],
  tombstones: ReadonlyMap<string, unknown>,
): Set<string> {
  const dirty = new Set<string>();
  const markDirty = (path: string) => {
    dirty.add(path);
    forEachAncestor(path, (ancestor) => { dirty.add(ancestor); });
  };
  for (const path of tombstones.keys()) markDirty(path);
  for (const file of mergedFiles) if (file.originalPath !== undefined) markDirty(file.path);

  const dirInfo = new Map<string, { cid: CID; count: number; clean: boolean }>();
  const snapshotPresence = new Map<string, number>();
  for (const { parsed } of walked) {
    const touched = new Set<string>();
    const touch = (path: string) => {
      touched.add(path);
      forEachAncestor(path, (ancestor) => { touched.add(ancestor); });
    };
    for (const dir of parsed.directories) {
      touch(dir.path);
      const existing = dirInfo.get(dir.path);
      if (!existing) dirInfo.set(dir.path, { cid: dir.entry.cid, count: 1, clean: !dir.hasIgnored });
      else {
        existing.count += 1;
        if (dir.hasIgnored || !sameCid(existing.cid, dir.entry.cid)) existing.clean = false;
      }
    }
    for (const file of parsed.files) touch(file.path);
    for (const path of touched) snapshotPresence.set(path, (snapshotPresence.get(path) ?? 0) + 1);
  }

  const passthrough = new Set<string>();
  for (const path of [...mergedDirectories.keys()].sort(comparePathsByDepth)) {
    if (hasAncestorIn(path, passthrough) || dirty.has(path) || tombstones.has(path) || hasAncestorIn(path, tombstones)) continue;
    const info = dirInfo.get(path);
    if (info?.clean && info.count === snapshotPresence.get(path) && sameCid(info.cid, mergedDirectories.get(path)!.entry.cid)) {
      passthrough.add(path);
    }
  }
  return passthrough;
}
