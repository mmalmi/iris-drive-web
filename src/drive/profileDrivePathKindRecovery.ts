import { toHex } from '@hashtree/core';
import type {
  ProfileDriveRootCandidate,
  SnapshotDirectory,
  SnapshotFile,
  SnapshotTombstone,
  SuppressedSnapshotDirectory,
  SuppressedSnapshotFile,
} from './profileDriveProjection';
import { sourceRootKey } from './profileDriveProjection';

/**
 * Legacy roots predate durable per-path replacement roles and may tombstone a
 * whole losing subtree. Recover only the newest marker generation under an
 * otherwise visible kind collision; carried older markers remain deletions.
 * Equal timestamps intentionally prefer a visible conflict over data loss.
 */
export function recoverSuppressedPathKindCandidates(
  fileMerge: { files: SnapshotFile[]; suppressed: SuppressedSnapshotFile[] },
  directoryMerge: {
    directories: Map<string, SnapshotDirectory>;
    suppressed: SuppressedSnapshotDirectory[];
  },
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
  legacySourceRoots: ReadonlySet<string>,
): { files: SnapshotFile[]; directories: Map<string, SnapshotDirectory> } {
  const files = [...fileMerge.files];
  const directories = new Map(directoryMerge.directories);
  const recoveredFileKeys = new Set<string>();
  const recoveredDirectoryKeys = new Set<string>();

  for (const replacement of fileMerge.files) {
    if (!legacySourceRoots.has(sourceRootKey(replacement.source))) continue;
    const collisionPath = replacement.originalPath ?? replacement.path;
    const suppressedCollision = directoryMerge.suppressed.find(({ directory, tombstone }) => (
      directory.path === collisionPath
      && suppressionBelongsToReplacement(
        tombstone,
        replacement.source,
      )
      && isNewestCollisionTombstone(tombstone, collisionPath, replacement.source, tombstones)
    ));
    const visibleCollision = directoryMerge.directories.get(collisionPath);
    if (!suppressedCollision && !visibleCollision) continue;
    recoverSuppressedSubtree(
      collisionPath,
      replacement.source,
      fileMerge.suppressed,
      directoryMerge.suppressed,
      tombstones,
      files,
      directories,
      recoveredFileKeys,
      recoveredDirectoryKeys,
    );
  }

  for (const replacement of directoryMerge.directories.values()) {
    if (!legacySourceRoots.has(sourceRootKey(replacement.source))) continue;
    const suppressedCollision = fileMerge.suppressed.find(({ file, tombstone }) => (
      file.path === replacement.path
      && suppressionBelongsToReplacement(
        tombstone,
        replacement.source,
      )
      && isNewestCollisionTombstone(tombstone, replacement.path, replacement.source, tombstones)
    ));
    const visibleCollision = fileMerge.files.find((file) => file.path === replacement.path);
    if (!suppressedCollision && !visibleCollision) continue;
    recoverSuppressedSubtree(
      replacement.path,
      replacement.source,
      fileMerge.suppressed,
      directoryMerge.suppressed,
      tombstones,
      files,
      directories,
      recoveredFileKeys,
      recoveredDirectoryKeys,
    );
  }

  return { files, directories };
}

function recoverSuppressedSubtree(
  collisionPath: string,
  replacementSource: ProfileDriveRootCandidate,
  suppressedFiles: SuppressedSnapshotFile[],
  suppressedDirectories: SuppressedSnapshotDirectory[],
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
  files: SnapshotFile[],
  directories: Map<string, SnapshotDirectory>,
  recoveredFileKeys: Set<string>,
  recoveredDirectoryKeys: Set<string>,
): void {
  for (const candidate of suppressedFiles) {
    if (!pathIsAtOrBelow(candidate.file.path, collisionPath)
      || !suppressionBelongsToReplacement(
        candidate.tombstone,
        replacementSource,
      )
      || !isNewestCollisionTombstone(
        candidate.tombstone,
        collisionPath,
        replacementSource,
        tombstones,
      )) continue;
    const key = [
      candidate.file.path,
      candidate.file.source.event.pubkey,
      toHex(candidate.file.entry.cid.hash),
    ].join(':');
    if (recoveredFileKeys.has(key)) continue;
    files.push(candidate.file);
    recoveredFileKeys.add(key);
  }
  for (const candidate of suppressedDirectories) {
    if (!pathIsAtOrBelow(candidate.directory.path, collisionPath)
      || !suppressionBelongsToReplacement(
        candidate.tombstone,
        replacementSource,
      )
      || !isNewestCollisionTombstone(
        candidate.tombstone,
        collisionPath,
        replacementSource,
        tombstones,
      )) continue;
    const key = `${candidate.directory.path}:${candidate.directory.source.event.pubkey}`;
    if (recoveredDirectoryKeys.has(key)) continue;
    if (!directories.has(candidate.directory.path)) {
      directories.set(candidate.directory.path, candidate.directory);
    }
    recoveredDirectoryKeys.add(key);
  }
}

function suppressionBelongsToReplacement(
  tombstone: SnapshotTombstone,
  replacement: ProfileDriveRootCandidate,
): boolean {
  return sameRootSource(tombstone.source, replacement);
}

function isNewestCollisionTombstone(
  candidate: SnapshotTombstone,
  collisionPath: string,
  replacement: ProfileDriveRootCandidate,
  tombstones: ReadonlyMap<string, SnapshotTombstone>,
): boolean {
  let newest = Number.NEGATIVE_INFINITY;
  for (const tombstone of tombstones.values()) {
    if (pathIsAtOrBelow(tombstone.path, collisionPath)
      && sameRootSource(tombstone.source, replacement)) {
      newest = Math.max(newest, tombstone.tombstonedAt);
    }
  }
  return candidate.tombstonedAt === newest;
}

function sameRootSource(
  left: ProfileDriveRootCandidate,
  right: ProfileDriveRootCandidate,
): boolean {
  return left.event.pubkey === right.event.pubkey
    && toHex(left.parsed.root.hash) === toHex(right.parsed.root.hash);
}

function pathIsAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}
