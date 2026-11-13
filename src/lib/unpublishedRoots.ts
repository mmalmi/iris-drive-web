/**
 * Versions of a Drive this device saved but had not published when the page
 * was last closed.
 *
 * The registry reads them from storage when the page loads and tries to
 * publish them a second later. On a slow start the way to publish is not set
 * up by then, and the registry drops the attempt without planning another:
 * the version was then never published, and the Drive never showed it.
 */
import type { Hash, TreeVisibility } from '@hashtree/core';

interface UnpublishedRecord {
  hash: Hash;
  key?: Hash;
  visibility?: TreeVisibility;
  labels?: string[];
  source?: string;
  dirty: boolean;
}

export interface UnpublishedRootRegistry {
  getAllRecords(): Map<string, UnpublishedRecord>;
  setLocal(
    scope: string,
    treeName: string,
    hash: Hash,
    options?: { key?: Hash; visibility?: TreeVisibility; labels?: string[] },
  ): void;
}

/** True for a version this device saved and has not published yet. */
export function isUnpublishedOwnWrite(record: { dirty?: boolean; source?: string } | null | undefined): boolean {
  return record?.dirty === true && record.source === 'local-write';
}

/**
 * Queues every unpublished version for publishing again. Called once
 * publishing is possible. Returns how many were queued.
 */
export function requeueUnpublishedRoots(registry: UnpublishedRootRegistry): number {
  let queued = 0;
  for (const [key, record] of [...registry.getAllRecords().entries()]) {
    if (!isUnpublishedOwnWrite(record)) continue;
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1) continue;
    registry.setLocal(key.slice(0, slash), key.slice(slash + 1), record.hash, {
      key: record.key,
      visibility: record.visibility,
      labels: record.labels,
    });
    queued += 1;
  }
  return queued;
}
