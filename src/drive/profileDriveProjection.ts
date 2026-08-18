import {
  LinkType,
  toHex,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import type { Event } from 'nostr-tools';
import {
  isDriveRootEventNewer,
  type ParsedDriveRootEvent,
  type RootObservation,
  type RootParent,
} from './protocol';

const META_DIR = '.hashtree';
const TOMBSTONES_DIR = 'tombstones';
const IGNORED_NAMES = new Set([
  '.ds_store',
  '.hashtree',
  '.trash',
  '$recycle.bin',
  'thumbs.db',
  'desktop.ini',
]);

export type ProfileDriveRootCandidate = {
  event: Event;
  parsed: ParsedDriveRootEvent;
};

export type MaterializedProfileDrive = {
  root: CID;
  updatedAt: number;
  sourceRootCount: number;
};

type SnapshotFile = {
  path: string;
  entry: TreeEntry;
  source: ProfileDriveRootCandidate;
};

type SnapshotTombstone = {
  path: string;
  tombstonedAt: number;
  source: ProfileDriveRootCandidate;
};

type SnapshotDirectory = {
  path: string;
  entry: TreeEntry;
  source: ProfileDriveRootCandidate;
};

type ProfileDriveSnapshot = {
  files: SnapshotFile[];
  tombstones: SnapshotTombstone[];
  directories: SnapshotDirectory[];
};

type RootRelation = 'same' | 'left-descends' | 'right-descends' | 'concurrent';

function projectionKey(rootScopeId: string, driveId: string): string {
  return `${rootScopeId}/${driveId}`;
}

/**
 * Retains one latest signed root per AppKey and materializes the logical Drive
 * view across the currently authorized roots.
 */
export class ProfileDriveProjection {
  private readonly roots = new Map<string, Map<string, ProfileDriveRootCandidate>>();

  add(event: Event, parsed: ParsedDriveRootEvent): boolean {
    if (event.pubkey !== parsed.app_key_pubkey_hex) return false;
    const key = projectionKey(parsed.root_scope_id, parsed.drive_id);
    let byAppKey = this.roots.get(key);
    if (!byAppKey) {
      byAppKey = new Map();
      this.roots.set(key, byAppKey);
    }

    const current = byAppKey.get(event.pubkey);
    if (current && !isDriveRootEventNewer(event, current.event)) return false;
    byAppKey.set(event.pubkey, { event, parsed });
    return true;
  }

  clear(rootScopeId?: string, driveId?: string): void {
    if (rootScopeId && driveId) {
      this.roots.delete(projectionKey(rootScopeId, driveId));
    } else {
      this.roots.clear();
    }
  }

  /**
   * Drop cached contributions that no longer belong to an authorized AppKey.
   * A later relay backfill can add a key again if a subsequent roster permits it.
   */
  pruneUnauthorized(
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
  ): boolean {
    const key = projectionKey(rootScopeId, driveId);
    const byAppKey = this.roots.get(key);
    if (!byAppKey) return false;

    let changed = false;
    for (const appKey of byAppKey.keys()) {
      if (!authorizedAppKeys.has(appKey)) {
        byAppKey.delete(appKey);
        changed = true;
      }
    }
    if (byAppKey.size === 0) this.roots.delete(key);
    return changed;
  }

  hasAuthorizedRoots(
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
  ): boolean {
    const byAppKey = this.roots.get(projectionKey(rootScopeId, driveId));
    if (!byAppKey) return false;
    for (const appKey of byAppKey.keys()) {
      if (authorizedAppKeys.has(appKey)) return true;
    }
    return false;
  }

  observations(
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
  ): Record<string, RootObservation> {
    return Object.fromEntries(this.authorizedRoots(rootScopeId, driveId, authorizedAppKeys)
      .map(({ event, parsed }) => [event.pubkey, {
        app_key_seq: parsed.app_key_seq,
        root_cid: toHex(parsed.root.hash),
      }]));
  }

  contributionRoot(
    rootScopeId: string,
    driveId: string,
    appKeyPubkey: string,
  ): CID | null {
    return this.roots
      .get(projectionKey(rootScopeId, driveId))
      ?.get(appKeyPubkey)
      ?.parsed.root ?? null;
  }

  async materialize(
    tree: HashTree,
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<MaterializedProfileDrive | null> {
    const roots = this.authorizedRoots(rootScopeId, driveId, authorizedAppKeys);
    if (roots.length === 0) return null;

    const settledSnapshots = await Promise.allSettled(
      roots.map((root) => walkProfileDriveRoot(tree, root, signal)),
    );
    const failure = settledSnapshots.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      // Applying only the roots that happened to be locally available makes
      // files disappear transiently and can then publish that partial view.
      // Keep every candidate retained and retry the entire projection later.
      throw failure.reason;
    }
    const snapshots = settledSnapshots.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));
    if (snapshots.length === 0) throw new Error('No readable profile Drive roots');
    const tombstones = mergeSnapshotTombstones(snapshots);
    const merged = resolvePathKindConflicts(
      mergeSnapshotFiles(snapshots, tombstones),
      mergeSnapshotDirectories(snapshots, tombstones),
    );
    const { files, directories } = merged;
    let root = (await tree.putDirectory([])).cid;

    const directoryPaths = new Set<string>(directories.keys());
    for (const file of files) {
      const segments = splitPath(file.path);
      for (let depth = 1; depth < segments.length; depth += 1) {
        directoryPaths.add(segments.slice(0, depth).join('/'));
      }
    }

    for (const path of [...directoryPaths].sort(comparePathsByDepth)) {
      root = await ensureDirectory(tree, root, path, directories.get(path)?.entry.meta, signal);
    }
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
      const segments = splitPath(file.path);
      const name = segments.pop();
      if (!name) continue;
      root = await tree.setEntry(
        root,
        segments,
        name,
        file.entry.cid,
        file.entry.size,
        file.entry.type,
        file.entry.meta,
      );
    }

    return {
      root,
      updatedAt: roots.reduce((latest, candidate) => Math.max(latest, candidate.parsed.published_at), 0),
      sourceRootCount: snapshots.length,
    };
  }

  private authorizedRoots(
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
  ): ProfileDriveRootCandidate[] {
    const byAppKey = this.roots.get(projectionKey(rootScopeId, driveId));
    if (!byAppKey) return [];
    return [...byAppKey.entries()]
      .filter(([appKey]) => authorizedAppKeys.has(appKey))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, candidate]) => candidate);
  }
}

export const profileDriveProjection = new ProfileDriveProjection();

async function walkProfileDriveRoot(
  tree: HashTree,
  source: ProfileDriveRootCandidate,
  signal?: AbortSignal,
): Promise<ProfileDriveSnapshot> {
  const snapshot: ProfileDriveSnapshot = { files: [], tombstones: [], directories: [] };
  await walkVisibleDirectory(tree, source.parsed.root, '', source, snapshot, signal);
  return snapshot;
}

async function walkVisibleDirectory(
  tree: HashTree,
  directory: CID,
  prefix: string,
  source: ProfileDriveRootCandidate,
  snapshot: ProfileDriveSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const entries = await tree.listDirectory(directory, signal);
  for (const entry of entries) {
    if (!prefix && entry.name === META_DIR) {
      if (entry.type === LinkType.Dir) {
        await walkMetadataDirectory(tree, entry.cid, source, snapshot, signal);
      }
      continue;
    }
    if (shouldIgnoreName(entry.name)) continue;

    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === LinkType.Dir) {
      snapshot.directories.push({ path, entry, source });
      await walkVisibleDirectory(tree, entry.cid, path, source, snapshot, signal);
    } else {
      snapshot.files.push({ path, entry, source });
    }
  }
}

async function walkMetadataDirectory(
  tree: HashTree,
  directory: CID,
  source: ProfileDriveRootCandidate,
  snapshot: ProfileDriveSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const entries = await tree.listDirectory(directory, signal);
  const tombstones = entries.find((entry) => entry.name === TOMBSTONES_DIR && entry.type === LinkType.Dir);
  if (tombstones) {
    await walkTombstones(tree, tombstones.cid, '', source, snapshot, signal);
  }
}

async function walkTombstones(
  tree: HashTree,
  directory: CID,
  prefix: string,
  source: ProfileDriveRootCandidate,
  snapshot: ProfileDriveSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  const entries = await tree.listDirectory(directory, signal);
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === LinkType.Dir) {
      await walkTombstones(tree, entry.cid, path, source, snapshot, signal);
      continue;
    }
    const raw = await tree.readFile(entry.cid);
    if (!raw) continue;
    const tombstonedAt = Number(new TextDecoder().decode(raw).trim());
    if (Number.isSafeInteger(tombstonedAt)) {
      snapshot.tombstones.push({ path, tombstonedAt, source });
    }
  }
}

function mergeSnapshotTombstones(
  snapshots: ProfileDriveSnapshot[],
): Map<string, SnapshotTombstone> {
  const tombstones = new Map<string, SnapshotTombstone>();
  for (const snapshot of snapshots) {
    for (const tombstone of snapshot.tombstones) {
      const current = tombstones.get(tombstone.path);
      if (!current || tombstoneWins(tombstone, current)) {
        tombstones.set(tombstone.path, tombstone);
      }
    }
  }
  return tombstones;
}

function mergeSnapshotFiles(
  snapshots: ProfileDriveSnapshot[],
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): SnapshotFile[] {
  const writes = new Map<string, SnapshotFile[]>();

  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const current = writes.get(file.path) ?? [];
      current.push(file);
      writes.set(file.path, current);
    }
  }

  const visible: SnapshotFile[] = [];
  const conflicts: Array<{ originalPath: string; file: SnapshotFile }> = [];
  const occupiedPaths = new Set<string>();

  for (const [path, candidates] of [...writes].sort(([left], [right]) => left.localeCompare(right))) {
    const winner = candidates.reduce((current, candidate) => (
      writeWins(candidate, current) ? candidate : current
    ));
    const tombstone = applicableTombstone(path, tombstones);
    const suppressed = !!tombstone && tombstoneSuppressesWrite(tombstone, winner);
    if (!suppressed) {
      visible.push(winner);
      occupiedPaths.add(path);
      for (const candidate of candidates) {
        if (candidate === winner || sameFileIdentity(candidate, winner)) continue;
        if (rootRelation(candidate.source, winner.source) === 'concurrent'
          && rootsAreCausal(candidate.source)
          && rootsAreCausal(winner.source)) {
          conflicts.push({ originalPath: path, file: candidate });
        }
      }
    } else if (
      tombstone
      && rootRelation(tombstone.source, winner.source) === 'concurrent'
      && rootsAreCausal(tombstone.source)
      && rootsAreCausal(winner.source)
    ) {
      const concurrentWrites = candidates.filter((candidate) => (
        rootRelation(tombstone.source, candidate.source) === 'concurrent'
        && rootsAreCausal(tombstone.source)
        && rootsAreCausal(candidate.source)
      ));
      for (const candidate of uniqueFileIdentities(concurrentWrites)) {
        conflicts.push({ originalPath: path, file: candidate });
      }
    }
  }

  for (const { originalPath, file } of conflicts.sort(compareConflictFiles)) {
    const path = nextConflictPath(originalPath, file.source.event.pubkey, occupiedPaths);
    visible.push({ ...file, path });
    occupiedPaths.add(path);
  }
  return visible;
}

function mergeSnapshotDirectories(
  snapshots: ProfileDriveSnapshot[],
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): Map<string, SnapshotDirectory> {
  const candidates = new Map<string, SnapshotDirectory[]>();
  for (const snapshot of snapshots) {
    for (const directory of snapshot.directories) {
      const current = candidates.get(directory.path) ?? [];
      current.push(directory);
      candidates.set(directory.path, current);
    }
  }
  const directories = new Map<string, SnapshotDirectory>();
  for (const [path, entries] of candidates) {
    const tombstone = applicableTombstone(path, tombstones);
    const visible = tombstone
      ? entries.filter((entry) => !tombstoneSuppressesSource(tombstone, entry.source))
      : entries;
    if (visible.length === 0) continue;
    directories.set(path, visible.reduce((current, candidate) => (
      sourceWins(candidate.source, current.source) ? candidate : current
    )));
  }
  return directories;
}

/**
 * Files and directories are merged independently first, but a visible path
 * cannot be both kinds. Causal replacement owns the canonical path. A
 * concurrent directory remains canonical so its whole subtree stays intact,
 * while the file is surfaced with the same conflict naming used for ordinary
 * write conflicts. When a newer file causally replaces a directory, move the
 * complete older subtree under a conflict-named directory instead.
 */
function resolvePathKindConflicts(
  initialFiles: SnapshotFile[],
  initialDirectories: Map<string, SnapshotDirectory>,
): { files: SnapshotFile[]; directories: Map<string, SnapshotDirectory> } {
  let files = [...initialFiles];
  let directories = new Map(initialDirectories);

  while (true) {
    const collision = files
      .filter((file) => directories.has(file.path))
      .sort((left, right) => comparePathsByDepth(left.path, right.path))[0];
    if (!collision) break;

    const directory = directories.get(collision.path)!;
    const relation = rootRelation(directory.source, collision.source);
    if (relation !== 'right-descends') {
      const occupied = collectOccupiedPaths(
        files.filter((file) => file !== collision),
        directories,
      );
      const conflict = nextConflictPath(
        collision.path,
        collision.source.event.pubkey,
        occupied,
      );
      files = files.map((file) => (
        file === collision ? { ...file, path: conflict } : file
      ));
      continue;
    }

    const prefix = collision.path;
    const movingDirectories = [...directories.values()]
      .filter((entry) => pathIsAtOrBelow(entry.path, prefix));
    const movingFiles = files
      .filter((file) => file.path !== prefix && pathIsAtOrBelow(file.path, prefix));
    const stationaryDirectories = [...directories.values()]
      .filter((entry) => !pathIsAtOrBelow(entry.path, prefix));
    const stationaryFiles = files.filter((file) => !movingFiles.includes(file));
    const occupied = collectOccupiedPaths(stationaryFiles, new Map(
      stationaryDirectories.map((entry) => [entry.path, entry]),
    ));
    const conflictRoot = nextSubtreeConflictPath(
      prefix,
      directory.source.event.pubkey,
      [
        ...movingDirectories.map((entry) => entry.path),
        ...movingFiles.map((file) => file.path),
      ],
      occupied,
    );

    directories = new Map([
      ...stationaryDirectories.map((entry) => [entry.path, entry] as const),
      ...movingDirectories.map((entry) => {
        const path = remapSubtreePath(entry.path, prefix, conflictRoot);
        return [path, { ...entry, path }] as const;
      }),
    ]);
    const movingFileSet = new Set(movingFiles);
    files = files.map((file) => {
      if (!movingFileSet.has(file)) return file;
      return { ...file, path: remapSubtreePath(file.path, prefix, conflictRoot) };
    });
  }

  return { files, directories };
}

function collectOccupiedPaths(
  files: SnapshotFile[],
  directories: ReadonlyMap<string, SnapshotDirectory>,
): Set<string> {
  const occupied = new Set<string>();
  for (const path of [
    ...files.map((file) => file.path),
    ...directories.keys(),
  ]) {
    const segments = splitPath(path);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      occupied.add(segments.slice(0, depth).join('/'));
    }
  }
  return occupied;
}

function nextSubtreeConflictPath(
  originalPath: string,
  appKeyPubkey: string,
  movingPaths: string[],
  occupied: ReadonlySet<string>,
): string {
  for (let index = 1; index <= 256; index += 1) {
    const label = index === 1 ? appKeyPubkey : `${appKeyPubkey} ${index}`;
    const candidate = conflictPath(originalPath, label);
    const targets = movingPaths.map((path) => remapSubtreePath(path, originalPath, candidate));
    if (targets.every((path) => !occupied.has(path))) return candidate;
  }
  return conflictPath(originalPath, `${appKeyPubkey} 257`);
}

function pathIsAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function remapSubtreePath(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

function applicableTombstone(
  path: string,
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): SnapshotTombstone | undefined {
  const parts = splitPath(path);
  let winner: SnapshotTombstone | undefined;
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const candidate = tombstones.get(parts.slice(0, depth).join('/'));
    if (candidate && (!winner || tombstoneWins(candidate, winner))) winner = candidate;
  }
  return winner;
}

function writeWins(candidate: SnapshotFile, current: SnapshotFile): boolean {
  return sourceWins(candidate.source, current.source);
}

function sameFileIdentity(left: SnapshotFile, right: SnapshotFile): boolean {
  return left.entry.size === right.entry.size && fileIdentity(left.entry) === fileIdentity(right.entry);
}

function fileIdentity(entry: TreeEntry): string {
  const wholeFileHash = entry.meta?.whole_file_hash;
  return typeof wholeFileHash === 'string' && /^[0-9a-f]{64}$/i.test(wholeFileHash)
    ? wholeFileHash.toLowerCase()
    : toHex(entry.cid.hash);
}

function uniqueFileIdentities(files: SnapshotFile[]): SnapshotFile[] {
  const byIdentity = new Map<string, SnapshotFile>();
  for (const file of files) {
    const identity = `${file.entry.size}:${fileIdentity(file.entry)}`;
    const current = byIdentity.get(identity);
    if (!current || sourceWins(file.source, current.source)) byIdentity.set(identity, file);
  }
  return [...byIdentity.values()];
}

function rootsAreCausal(source: ProfileDriveRootCandidate): boolean {
  return source.parsed.app_key_seq > 0
    || source.parsed.rootRef.parents.length > 0
    || Object.keys(source.parsed.rootRef.observed).length > 0;
}

function compareConflictFiles(
  left: { originalPath: string; file: SnapshotFile },
  right: { originalPath: string; file: SnapshotFile },
): number {
  return left.originalPath.localeCompare(right.originalPath)
    || left.file.source.event.pubkey.localeCompare(right.file.source.event.pubkey)
    || left.file.source.parsed.app_key_seq - right.file.source.parsed.app_key_seq
    || toHex(left.file.source.parsed.root.hash).localeCompare(toHex(right.file.source.parsed.root.hash))
    || fileIdentity(left.file.entry).localeCompare(fileIdentity(right.file.entry));
}

function nextConflictPath(originalPath: string, appKeyPubkey: string, occupied: ReadonlySet<string>): string {
  for (let index = 1; index <= 256; index += 1) {
    const label = index === 1 ? appKeyPubkey : `${appKeyPubkey} ${index}`;
    const candidate = conflictPath(originalPath, label);
    if (!occupied.has(candidate)) return candidate;
  }
  return conflictPath(originalPath, `${appKeyPubkey} 257`);
}

function conflictPath(originalPath: string, appKeyLabel: string): string {
  const splitAt = originalPath.lastIndexOf('/');
  const directory = splitAt >= 0 ? originalPath.slice(0, splitAt + 1) : '';
  const name = splitAt >= 0 ? originalPath.slice(splitAt + 1) : originalPath;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = truncateUtf8(hasExtension ? name.slice(dot) : '', 48);
  const markerPrefix = ' (conflict from ';
  const markerSuffix = ')';
  const fixedBytes = byteLength(markerPrefix) + byteLength(markerSuffix) + byteLength(extension);
  const available = Math.max(0, 240 - fixedBytes);
  const label = truncateUtf8(appKeyLabel, Math.min(byteLength(appKeyLabel), Math.max(0, available - 1)));
  const truncatedStem = truncateUtf8(stem, Math.max(0, available - byteLength(label)));
  return `${directory}${truncatedStem}${markerPrefix}${label}${markerSuffix}${extension}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let result = '';
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (resultBytes + characterBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function tombstoneWins(candidate: SnapshotTombstone, current: SnapshotTombstone): boolean {
  const relation = rootRelation(candidate.source, current.source);
  if (relation === 'same' || relation === 'left-descends') return true;
  if (relation === 'right-descends') return false;
  return candidate.tombstonedAt > current.tombstonedAt
    || (candidate.tombstonedAt === current.tombstonedAt
      && candidate.source.event.pubkey > current.source.event.pubkey);
}

function tombstoneSuppressesWrite(tombstone: SnapshotTombstone, write: SnapshotFile): boolean {
  return tombstoneSuppressesSource(tombstone, write.source);
}

function tombstoneSuppressesSource(
  tombstone: SnapshotTombstone,
  source: ProfileDriveRootCandidate,
): boolean {
  const relation = rootRelation(tombstone.source, source);
  if (relation === 'same' || relation === 'left-descends') return true;
  if (relation === 'right-descends') return false;
  return tombstone.tombstonedAt >= source.parsed.published_at;
}

function sourceWins(candidate: ProfileDriveRootCandidate, current: ProfileDriveRootCandidate): boolean {
  const relation = rootRelation(candidate, current);
  if (relation === 'same' || relation === 'left-descends') return true;
  if (relation === 'right-descends') return false;
  return candidate.parsed.published_at > current.parsed.published_at
    || (candidate.parsed.published_at === current.parsed.published_at
      && candidate.event.pubkey > current.event.pubkey);
}

function rootRelation(
  left: ProfileDriveRootCandidate,
  right: ProfileDriveRootCandidate,
): RootRelation {
  if (toHex(left.parsed.root.hash) === toHex(right.parsed.root.hash)) return 'same';
  const leftDescends = rootObserves(left, right);
  const rightDescends = rootObserves(right, left);
  if (leftDescends && !rightDescends) return 'left-descends';
  if (!leftDescends && rightDescends) return 'right-descends';
  return 'concurrent';
}

function rootObserves(
  newer: ProfileDriveRootCandidate,
  candidate: ProfileDriveRootCandidate,
): boolean {
  if (toHex(newer.parsed.root.hash) === toHex(candidate.parsed.root.hash)) return true;
  if (
    newer.event.pubkey === candidate.event.pubkey
    && newer.parsed.app_key_seq > 0
    && candidate.parsed.app_key_seq > 0
    && newer.parsed.app_key_seq > candidate.parsed.app_key_seq
  ) {
    return true;
  }

  if (newer.parsed.rootRef.parents.some((parent) => (
    (parent.app_key_pubkey ?? parent.device_id) === candidate.event.pubkey
    && rootReferenceCovers(parent, candidate)
  ))) {
    return true;
  }
  const observed = newer.parsed.rootRef.observed[candidate.event.pubkey];
  return !!observed && rootReferenceCovers(observed, candidate);
}

function rootReferenceCovers(
  reference: Pick<RootParent, 'root_cid' | 'app_key_seq' | 'device_seq'>,
  candidate: ProfileDriveRootCandidate,
): boolean {
  const referenceHash = reference.root_cid.split(':', 1)[0]?.toLowerCase();
  if (referenceHash === toHex(candidate.parsed.root.hash)) return true;
  const sequence = reference.app_key_seq ?? reference.device_seq ?? 0;
  return candidate.parsed.app_key_seq > 0 && sequence > candidate.parsed.app_key_seq;
}

async function ensureDirectory(
  tree: HashTree,
  root: CID,
  path: string,
  meta: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<CID> {
  const segments = splitPath(path);
  if (segments.length === 0) return root;
  const existing = await tree.resolvePath(root, segments, signal);
  if (existing?.type === LinkType.Dir) return root;
  if (existing) return root;

  const name = segments.pop();
  if (!name) return root;
  const empty = await tree.putDirectory([]);
  return tree.setEntry(root, segments, name, empty.cid, 0, LinkType.Dir, meta);
}

function shouldIgnoreName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_NAMES.has(lower)
    || name.startsWith('._')
    || lower.startsWith('.trash-')
    || name.endsWith('~')
    || (name.startsWith('#') && name.endsWith('#'))
    || lower.endsWith('.sbak');
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function comparePathsByDepth(left: string, right: string): number {
  return splitPath(left).length - splitPath(right).length || left.localeCompare(right);
}
