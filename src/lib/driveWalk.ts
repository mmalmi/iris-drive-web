/**
 * Reading the person's own Drive folder by folder: My Drive and the shared
 * folders this device holds. Search and Photos both read it.
 *
 * The trees are read from what this device already has; nothing waits for a
 * relay. A walk reports what it finds as it goes. It stops after a bounded
 * number of folders so a huge Drive stays quick. What it found is kept per
 * root hash, and each folder's listing per folder hash, so reading a tree
 * again after a change reads only the folders that changed.
 */
import { LinkType, toHex, type CID, type TreeEntry } from '@hashtree/core';
import { getTree } from '../store';
import { documentKindInfo } from './documentNames';
import { isHiddenDirectoryName } from './directoryEntryVisibility';

export interface DriveRoot {
  /** The route scope the tree opens under: a Drive profile id, an npub or a shared folder id. */
  scope: string;
  /** Shown beside what is found in this tree: "My Drive" or the shared folder's name. */
  label: string;
  cid: CID;
  /** Paths left out: folders of My Drive that now live as shared folders. */
  skip?: string[];
  /** The tree is a shared folder. */
  shared?: boolean;
}

/** A file, folder or document found in a tree. */
export interface DriveFound {
  /** From the top of the tree down to the entry, ending with its own name. */
  path: string[];
  entry: TreeEntry;
}

export interface DriveWalk {
  found: DriveFound[];
  /** The top folder has been read. */
  topListed: boolean;
  done: boolean;
}

export const DRIVE_TREE_NAME = 'main';
const MAX_FOLDERS = 2000;
const PARALLEL_LISTINGS = 4;
const LISTING_TIMEOUT_MS = 4000;
const KEPT_LISTINGS = 5000;

const walks = new Map<string, DriveWalk>();
const listeners = new Set<() => void>();
/** Folder listings by folder hash; the same hash always lists the same. */
const listings = new Map<string, TreeEntry[]>();

function walkKey(root: DriveRoot): string {
  return `${root.scope}:${toHex(root.cid.hash)}:${root.label}:${(root.skip ?? []).join('\n')}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called whenever a walk finds more, or finishes. */
export function onDriveWalkProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where an entry opens in Drive. */
export function driveHref(scope: string, path: string[]): string {
  return `#/${[scope, DRIVE_TREE_NAME, ...path].map(encodeURIComponent).join('/')}`;
}

/** A folder's entries, or null when its blocks are not here: those are skipped rather than waited for. */
export async function listFolder(cid: CID): Promise<TreeEntry[] | null> {
  const key = toHex(cid.hash);
  const kept = listings.get(key);
  if (kept) {
    listings.delete(key);
    listings.set(key, kept);
    return kept;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      getTree().listDirectory(cid),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LISTING_TIMEOUT_MS); }),
    ]);
    if (entries) {
      listings.set(key, entries);
      if (listings.size > KEPT_LISTINGS) listings.delete(listings.keys().next().value!);
    }
    return entries;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Start reading the trees not read yet. Trees that have changed are read again. */
export function startDriveWalk(roots: DriveRoot[]): void {
  const wanted = new Set(roots.map(walkKey));
  for (const key of walks.keys()) {
    if (!wanted.has(key)) walks.delete(key);
  }
  for (const root of roots) {
    const key = walkKey(root);
    if (walks.has(key)) continue;
    const state: DriveWalk = { found: [], topListed: false, done: false };
    walks.set(key, state);
    void walkInParallel(root, state);
  }
}

/** What has been found in a tree so far, if its walk has started. */
export function driveWalk(root: DriveRoot): DriveWalk | undefined {
  return walks.get(walkKey(root));
}

/** Whether every tree has been read as far as the walk goes. */
export function driveWalkDone(roots: DriveRoot[]): boolean {
  return roots.every((root) => walks.get(walkKey(root))?.done ?? false);
}

async function walkInParallel(root: DriveRoot, state: DriveWalk): Promise<void> {
  // Listing folders one after another is slow when their blocks come from
  // the worker one round trip at a time; a few at once is enough.
  const queue: Array<{ cid: CID; path: string[] }> = [{ cid: root.cid, path: [] }];
  const skip = new Set(root.skip ?? []);
  let folders = 0;
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < PARALLEL_LISTINGS && queue.length > 0 && folders < MAX_FOLDERS) {
        const folder = queue.shift()!;
        folders += 1;
        active += 1;
        void listFolder(folder.cid).then((entries) => {
          if (folder.path.length === 0) state.topListed = true;
          for (const entry of entries ?? []) {
            if (isHiddenDirectoryName(entry.name)) continue;
            const path = [...folder.path, entry.name];
            if (skip.has(path.join('/'))) continue;
            state.found.push({ path, entry });
            // A document is one item; what is inside it is not.
            if (entry.type === LinkType.Dir && !documentKindInfo(entry.name)) queue.push({ cid: entry.cid, path });
          }
        }).finally(() => {
          active -= 1;
          notify();
          pump();
        });
      }
      if (active === 0) resolve();
    };
    pump();
  });
  state.done = true;
  notify();
}
