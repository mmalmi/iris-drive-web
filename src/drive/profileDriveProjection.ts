import {
  toHex,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import type { Event } from 'nostr-tools';
import {
  isDriveRootEventNewer,
  type ParsedDriveRootEvent,
  type SharedFolder,
  type RootObservation,
} from './protocol';
import { rootReferenceCovers } from './protocolRoots';
import { recoverSuppressedPathKindCandidates } from './profileDrivePathKindRecovery';
import { sameCid } from './profileDrivePathKindMetadata';
import {
  preferredKindFromActiveRole,
  type PathKindSourceState,
} from './profileDrivePathKindPreference';
import { conflictPath } from './profileDriveConflictPath';
import { DirectoryBuilder } from './directoryBuilder';
import {
  comparePathsByDepth,
  findPassthroughDirectories,
  hasAncestorIn,
  META_DIR,
  splitPath,
  walkProfileDriveRoot,
} from './profileDriveSnapshotWalk';

export type ProfileDriveRootCandidate = {
  event: Event;
  parsed: ParsedDriveRootEvent;
};

export type MaterializedProfileDrive = {
  root: CID;
  updatedAt: number;
  sourceRootCount: number;
};

export type SnapshotFile = {
  path: string;
  originalPath?: string;
  entry: TreeEntry;
  source: ProfileDriveRootCandidate;
};

export type SnapshotTombstone = {
  path: string;
  tombstonedAt: number;
  source: ProfileDriveRootCandidate;
};

export type SnapshotDirectory = {
  path: string;
  entry: TreeEntry;
  source: ProfileDriveRootCandidate;
};

export type SuppressedSnapshotFile = {
  file: SnapshotFile;
  tombstone: SnapshotTombstone;
};

export type SuppressedSnapshotDirectory = {
  directory: SnapshotDirectory;
  tombstone: SnapshotTombstone;
};

export type ProfileDriveSnapshot = {
  files: SnapshotFile[];
  tombstones: SnapshotTombstone[];
  directories: SnapshotDirectory[];
  pathKindReplacements: Map<string, number>;
  returnDirectory?: CID;
  pathKindMetadataPresent: boolean;
  source: ProfileDriveRootCandidate;
};

export type RootRelation = 'same' | 'left-descends' | 'right-descends' | 'concurrent';

function projectionKey(rootScopeId: string, driveId: string): string {
  return `${rootScopeId}/${driveId}`;
}

export function sourceRootKey(source: ProfileDriveRootCandidate): string {
  return `${source.event.pubkey}:${toHex(source.parsed.root.hash)}`;
}

/**
 * Retains one latest signed root per AppKey and materializes the logical Drive
 * view across the currently authorized roots.
 */
export class ProfileDriveProjection {
  private readonly roots = new Map<string, Map<string, ProfileDriveRootCandidate>>();
  /** The deletions the view merged last took in, by Drive: path → when. */
  private readonly deletions = new Map<string, { root: string; at: Map<string, number> }>();

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

  /** Whether this exact signed root is already the retained one for its AppKey. */
  retains(rootScopeId: string, driveId: string, event: Event): boolean {
    return this.roots.get(projectionKey(rootScopeId, driveId))?.get(event.pubkey)?.event.id === event.id;
  }

  clear(rootScopeId?: string, driveId?: string): void {
    if (rootScopeId && driveId) {
      this.roots.delete(projectionKey(rootScopeId, driveId));
      this.deletions.delete(projectionKey(rootScopeId, driveId));
    } else {
      this.roots.clear();
      this.deletions.clear();
    }
  }

  /**
   * When `path`, or a folder above it, was last deleted or renamed away from
   * in the view merged last: 0 when never. A path can be shown again after
   * that, by a write made without knowing of the delete. With `root`, the
   * answer is null unless that view is `root`; it is null too before any view
   * has been merged.
   */
  deletedAt(rootScopeId: string, driveId: string, path: readonly string[], root?: CID): number | null {
    const merged = this.deletions.get(projectionKey(rootScopeId, driveId));
    if (!merged || (root && merged.root !== toHex(root.hash))) return null;
    let latest = 0;
    for (let depth = 1; depth <= path.length; depth += 1) {
      latest = Math.max(latest, merged.at.get(path.slice(0, depth).join('/')) ?? 0);
    }
    return latest;
  }

  /**
   * What the view merged last records as deleted or renamed away from below
   * `path` after `since`, as paths from `path` on. A rename marks every file
   * it took along, so these name the files a renamed folder now holds.
   */
  deletedBelow(rootScopeId: string, driveId: string, path: readonly string[], since = 0): string[] {
    const merged = this.deletions.get(projectionKey(rootScopeId, driveId));
    if (!merged || path.length === 0) return [];
    const prefix = `${path.join('/')}/`;
    return [...merged.at]
      .filter(([deleted, at]) => at > since && deleted.startsWith(prefix))
      .map(([deleted]) => deleted.slice(prefix.length));
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

  /** The newest version of each device this one holds: its sequence number and when it was published (unix seconds). */
  heldVersions(
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
  ): Record<string, { seq: number; publishedAt: number }> {
    return Object.fromEntries(this.authorizedRoots(rootScopeId, driveId, authorizedAppKeys)
      .map(({ event, parsed }) => [event.pubkey, { seq: parsed.app_key_seq, publishedAt: parsed.published_at }]));
  }

  contributionRoot(
    rootScopeId: string,
    driveId: string,
    appKeyPubkey: string,
    seen?: Record<string, number>,
  ): CID | null {
    const head = this.roots.get(projectionKey(rootScopeId, driveId))?.get(appKeyPubkey)?.parsed;
    if (!head) return null;
    if (seen && !Object.entries(seen).every(([writer, seq]) =>
      writer === appKeyPubkey ? seq < head.app_key_seq : seq <= (head.rootRef.observed[writer]?.app_key_seq ?? 0))) return null;
    return head.root;
  }

  async materialize(
    tree: HashTree,
    rootScopeId: string,
    driveId: string,
    authorizedAppKeys: ReadonlySet<string>,
    signal?: AbortSignal,
    folder?: SharedFolder,
  ): Promise<MaterializedProfileDrive | null> {
    const roots = this.authorizedRoots(rootScopeId, driveId, authorizedAppKeys);
    if (roots.length === 0) return null;

    if (driveId === 'trash') {
      const { readPrivateTrash, writePrivateTrash } = await import('./privateTrashTree');
      const view = await readPrivateTrash(tree, rootScopeId, roots.map(r => r.parsed.root), signal);
      return {
        root: await writePrivateTrash(tree, view),
        updatedAt: Math.max(...roots.map(r => r.parsed.published_at)),
        sourceRootCount: roots.length,
      };
    }

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
    const walked = settledSnapshots.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value] : []
    ));
    if (walked.length === 0) throw new Error('No readable profile Drive roots');
    const snapshots = walked.map((item) => item.snapshot);
    const builder = new DirectoryBuilder();
    const hasReturns = folder?.share_id === rootScopeId
      && driveId === 'main'
      && snapshots.some((snapshot) => snapshot.returnDirectory);
    if (hasReturns) {
      const { applyFileReturns } = await import('./fileReturnMarker');
      await applyFileReturns(tree, snapshots, folder, builder, signal);
    }

    const snapshotPathSets = new Map(snapshots.map((snapshot) => {
      const paths = new Set<string>();
      for (const file of snapshot.files) paths.add(file.path);
      for (const directory of snapshot.directories) paths.add(directory.path);
      return [snapshot, paths] as const;
    }));
    const tombstones = mergeSnapshotTombstones(snapshots, snapshotPathSets);

    // Single-root fast path: a root's own tombstones never suppress its own
    // entries and a single tree has no cross-writer conflicts. When there are
    // no ignored names or return markers, keep every subtree CID unchanged.
    if (walked.length === 1 && !hasReturns && !walked[0]!.parsed.hasIgnored) {
      const only = walked[0]!;
      signal?.throwIfAborted();
      const root = only.parsed.hasTopMeta
        ? (await tree.putDirectory(only.parsed.topEntries.filter((entry) => entry.name !== META_DIR))).cid
        : only.snapshot.source.parsed.root;
      this.deletions.set(projectionKey(rootScopeId, driveId), {
        root: toHex(root.hash),
        at: new Map([...tombstones].map(([path, tombstone]) => [path, tombstone.tombstonedAt])),
      });
      return {
        root,
        updatedAt: only.snapshot.source.parsed.published_at,
        sourceRootCount: 1,
      };
    }

    const pathKindSourceStates = new Map(snapshots.map((snapshot) => {
      const pathSet = snapshotPathSets.get(snapshot)!;
      return [
        sourceRootKey(snapshot.source),
        {
          metadataPresent: snapshot.pathKindMetadataPresent,
          activeReplacementPaths: new Set(snapshot.tombstones
            .filter((tombstone) => isActiveReplacementBarrier(snapshot, tombstone, pathSet))
            .map((tombstone) => tombstone.path)),
        },
      ] as const;
    }));
    const fileMerge = mergeSnapshotFiles(snapshots, tombstones);
    const directoryMerge = mergeSnapshotDirectories(snapshots, tombstones);
    const recovered = recoverSuppressedPathKindCandidates(
      fileMerge,
      directoryMerge,
      tombstones,
      new Set(snapshots
        .filter((snapshot) => !snapshot.pathKindMetadataPresent)
        .map((snapshot) => sourceRootKey(snapshot.source))),
    );
    const merged = resolvePathKindConflicts(
      recovered.files,
      recovered.directories,
      pathKindSourceStates,
    );
    const { files, directories } = merged;

    // Subtree pass-through: any merged directory whose immutable CID is clean
    // and identical across every snapshot touching it needs zero putDirectory calls.
    const passthrough = hasReturns
      ? new Set<string>()
      : findPassthroughDirectories(walked, directories, files, tombstones);

    for (const [path, directory] of directories) {
      if (hasAncestorIn(path, passthrough)) continue;
      if (passthrough.has(path)) {
        const segments = splitPath(path);
        const name = segments.pop();
        if (name) builder.directory(segments).setLeaf(name, { ...directory.entry, size: 0 });
      } else {
        builder.directory(splitPath(path)).meta = directory.entry.meta;
      }
    }
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
      if (hasAncestorIn(file.path, passthrough)) continue;
      const segments = splitPath(file.path);
      const name = segments.pop();
      if (!name) continue;
      builder.directory(segments).setLeaf(name, file.entry);
    }
    signal?.throwIfAborted();
    const root = await builder.put(tree);
    this.deletions.set(projectionKey(rootScopeId, driveId), {
      root: toHex(root.hash),
      at: new Map([...tombstones].map(([path, tombstone]) => [path, tombstone.tombstonedAt])),
    });

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

function mergeSnapshotTombstones(
  snapshots: ProfileDriveSnapshot[],
  snapshotPathSets: ReadonlyMap<ProfileDriveSnapshot, ReadonlySet<string>>,
): Map<string, SnapshotTombstone> {
  const tombstones = new Map<string, SnapshotTombstone>();
  for (const snapshot of snapshots) {
    const pathSet = snapshotPathSets.get(snapshot)!;
    for (const tombstone of snapshot.tombstones) {
      if (isActiveReplacementBarrier(snapshot, tombstone, pathSet)) continue;
      const current = tombstones.get(tombstone.path);
      if (!current || tombstoneWins(tombstone, current)) {
        tombstones.set(tombstone.path, tombstone);
      }
    }
  }
  return tombstones;
}

function isActiveReplacementBarrier(
  snapshot: ProfileDriveSnapshot,
  tombstone: SnapshotTombstone,
  pathSet: ReadonlySet<string>,
): boolean {
  if (snapshot.pathKindReplacements.get(tombstone.path) !== tombstone.tombstonedAt) return false;
  return pathSet.has(tombstone.path);
}

function mergeSnapshotFiles(
  snapshots: ProfileDriveSnapshot[],
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): { files: SnapshotFile[]; suppressed: SuppressedSnapshotFile[] } {
  const writes = new Map<string, SnapshotFile[]>();

  for (const snapshot of snapshots) {
    for (const file of snapshot.files) {
      const current = writes.get(file.path) ?? [];
      current.push(file);
      writes.set(file.path, current);
    }
  }

  const visible: SnapshotFile[] = [];
  const suppressedFiles: SuppressedSnapshotFile[] = [];
  const suppressedConflicts: Array<{
    originalPath: string;
    file: SnapshotFile;
    tombstone: SnapshotTombstone;
  }> = [];
  const conflicts: Array<{ originalPath: string; file: SnapshotFile }> = [];
  const occupiedPaths = new Set<string>();

  for (const [path, candidates] of [...writes].sort(([left], [right]) => left.localeCompare(right))) {
    const tombstone = applicableTombstone(path, tombstones);
    const unsuppressed: SnapshotFile[] = [];
    const causallySuppressed: SnapshotFile[] = [];
    for (const candidate of candidates) {
      if (!tombstone || !tombstoneSuppressesWrite(tombstone, candidate)) {
        unsuppressed.push(candidate);
        continue;
      }
      const concurrentConflict = rootRelation(tombstone.source, candidate.source) === 'concurrent'
        && rootsAreCausal(tombstone.source)
        && rootsAreCausal(candidate.source);
      if (concurrentConflict) conflicts.push({ originalPath: path, file: candidate });
      else causallySuppressed.push(candidate);
    }

    if (unsuppressed.length > 0) {
      const winner = unsuppressed.reduce((current, candidate) => (
        writeWins(candidate, current) ? candidate : current
      ));
      visible.push(winner);
      occupiedPaths.add(path);
      for (const candidate of unsuppressed) {
        if (candidate === winner || sameFileIdentity(candidate, winner)) continue;
        if (rootRelation(candidate.source, winner.source) === 'concurrent'
          && rootsAreCausal(candidate.source)
          && rootsAreCausal(winner.source)) {
          conflicts.push({ originalPath: path, file: candidate });
        }
      }
    }
    if (tombstone && causallySuppressed.length > 0) {
      const suppressedCandidates = uniqueFileIdentities(causallySuppressed);
      const primary = suppressedCandidates.reduce((current, candidate) => (
        sourceWins(candidate.source, current.source) ? candidate : current
      ));
      suppressedFiles.push({ file: primary, tombstone });
      for (const candidate of suppressedCandidates) {
        if (candidate === primary || sameFileIdentity(candidate, primary)) continue;
        suppressedConflicts.push({ originalPath: path, file: candidate, tombstone });
      }
    }
  }

  for (const { originalPath, file } of conflicts.sort(compareConflictFiles)) {
    const path = nextConflictPath(originalPath, file.source.event.pubkey, occupiedPaths);
    visible.push({ ...file, path, originalPath });
    occupiedPaths.add(path);
  }
  const suppressedOccupiedPaths = new Set([
    ...occupiedPaths,
    ...suppressedFiles.map(({ file }) => file.path),
  ]);
  for (const { originalPath, file, tombstone } of suppressedConflicts.sort(compareConflictFiles)) {
    const path = nextConflictPath(originalPath, file.source.event.pubkey, suppressedOccupiedPaths);
    suppressedFiles.push({ file: { ...file, path, originalPath }, tombstone });
    suppressedOccupiedPaths.add(path);
  }
  return { files: visible, suppressed: suppressedFiles };
}

function mergeSnapshotDirectories(
  snapshots: ProfileDriveSnapshot[],
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): {
  directories: Map<string, SnapshotDirectory>;
  suppressed: SuppressedSnapshotDirectory[];
} {
  const candidates = new Map<string, SnapshotDirectory[]>();
  for (const snapshot of snapshots) {
    for (const directory of snapshot.directories) {
      const current = candidates.get(directory.path) ?? [];
      current.push(directory);
      candidates.set(directory.path, current);
    }
  }
  const directories = new Map<string, SnapshotDirectory>();
  const suppressedDirectories: SuppressedSnapshotDirectory[] = [];
  for (const [path, entries] of candidates) {
    const tombstone = applicableTombstone(path, tombstones);
    const visible = tombstone
      ? entries.filter((entry) => !tombstoneSuppressesSource(tombstone, entry.source))
      : entries;
    if (visible.length > 0) {
      directories.set(path, visible.reduce((current, candidate) => (
        sourceWins(candidate.source, current.source) ? candidate : current
      )));
    }
    if (tombstone) {
      const suppressed = entries.filter((entry) => tombstoneSuppressesSource(tombstone, entry.source));
      if (suppressed.length > 0) {
        const winner = suppressed.reduce((current, candidate) => (
          sourceWins(candidate.source, current.source) ? candidate : current
        ));
        suppressedDirectories.push({
          directory: winner,
          tombstone,
        });
      }
    }
  }
  return { directories, suppressed: suppressedDirectories };
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
  pathKindSourceStates: ReadonlyMap<string, PathKindSourceState>,
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
    const activeRolePreference = preferredKindFromActiveRole(
      collision.path,
      sourceRootKey(directory.source),
      sourceRootKey(collision.source),
      pathKindSourceStates,
    );
    const fileIsCanonical = activeRolePreference === 'file'
      || (activeRolePreference === null && relation === 'right-descends');
    if (!fileIsCanonical) {
      const preferredConflict = conflictPath(
        collision.path,
        collision.source.event.pubkey,
      );
      const existingConflict = files.find((file) => (
        file !== collision
        && file.path === preferredConflict
        && sameEntryIdentity(file.entry, collision.entry)
      ));
      if (existingConflict) {
        // A previous materialization may already have copied this exact losing
        // file into the replacing AppKey's contribution. Reuse that immutable
        // copy instead of manufacturing "conflict … 2" on every later edit.
        files = files.filter((file) => file !== collision);
        continue;
      }
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
    const preferredConflict = conflictPath(
      prefix,
      directory.source.event.pubkey,
    );
    const existingConflict = stationaryDirectories.find((entry) => (
      entry.path === preferredConflict
      && sameEntryIdentity(entry.entry, directory.entry)
    ));
    if (existingConflict) {
      // The immutable directory CID proves the complete losing subtree is
      // already present at its deterministic conflict path. Drop the duplicate
      // canonical copy while retaining the replacing file and existing copy.
      directories = new Map(
        stationaryDirectories.map((entry) => [entry.path, entry] as const),
      );
      files = stationaryFiles;
      continue;
    }
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

function sameEntryIdentity(left: TreeEntry, right: TreeEntry): boolean {
  return left.type === right.type
    && left.size === right.size
    && sameCid(left.cid, right.cid)
    && JSON.stringify(left.meta ?? null) === JSON.stringify(right.meta ?? null);
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
  if (sourceRootKey(tombstone.source) === sourceRootKey(source)) return false;
  const relation = rootRelation(tombstone.source, source);
  if (relation === 'same') return true;
  if (relation === 'left-descends') return true;
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
  const sameVersion = left.event.pubkey === right.event.pubkey && left.parsed.app_key_seq === right.parsed.app_key_seq;
  const unversioned = left.parsed.app_key_seq === 0 || right.parsed.app_key_seq === 0;
  if ((sameVersion || unversioned) && toHex(left.parsed.root.hash) === toHex(right.parsed.root.hash)) return 'same';
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
  if (
    newer.event.pubkey === candidate.event.pubkey
    && newer.parsed.app_key_seq > 0
    && candidate.parsed.app_key_seq > 0
    && newer.parsed.app_key_seq > candidate.parsed.app_key_seq
  ) {
    return true;
  }

  const hash = toHex(candidate.parsed.root.hash);
  if (newer.parsed.rootRef.parents.some((parent) => (
    (parent.app_key_pubkey ?? parent.device_id) === candidate.event.pubkey
    && rootReferenceCovers(parent, candidate.parsed.app_key_seq, hash)
  ))) {
    return true;
  }
  const observed = newer.parsed.rootRef.observed[candidate.event.pubkey];
  return !!observed && rootReferenceCovers(observed, candidate.parsed.app_key_seq, hash);
}
