/**
 * Search over the person's own Drive: the names of files, folders and
 * documents in My Drive and in the shared folders this device holds.
 *
 * The trees are read from what this device already has; nothing waits for a
 * relay. A walk finds names folder by folder and reports them as it goes. It
 * stops after a bounded number of folders so a huge Drive stays quick, and
 * what it found is kept per root hash, so searching again costs nothing until
 * that tree changes.
 */
import { LinkType, toHex, type CID } from '@hashtree/core';
import { fileIcon } from './fileIcon';
import { getTree } from '../store';
import { documentKindInfo, documentTitle } from './documentNames';
import { isHiddenDirectoryName } from './directoryEntryVisibility';

export interface DriveSearchRoot {
  /** The route scope the tree opens under: a Drive profile id, an npub or a shared folder id. */
  scope: string;
  /** Shown beside results from this tree: "My Drive" or the shared folder's name. */
  label: string;
  cid: CID;
  /** Paths left out: folders of My Drive that now live as shared folders. */
  skip?: string[];
  /** The tree is a shared folder, found by its own name too. */
  shared?: boolean;
}

export interface DriveSearchItem {
  name: string;
  icon: string;
  href: string;
  /** Where it is: the tree's label and the folders above it. */
  where: string;
  folder: boolean;
}

const TREE_NAME = 'main';
const MAX_FOLDERS = 2000;
const PARALLEL_LISTINGS = 4;
const LISTING_TIMEOUT_MS = 4000;

interface Walk {
  items: DriveSearchItem[];
  done: boolean;
}

const walks = new Map<string, Walk>();
const listeners = new Set<() => void>();

function walkKey(root: DriveSearchRoot): string {
  return `${root.scope}:${toHex(root.cid.hash)}:${root.label}:${(root.skip ?? []).join('\n')}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Called whenever a walk finds more, or finishes. */
export function onDriveSearchProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function hrefFor(scope: string, path: string[]): string {
  return `#/${[scope, TREE_NAME, ...path].map(encodeURIComponent).join('/')}`;
}

function itemFor(root: DriveSearchRoot, path: string[], type: LinkType): DriveSearchItem {
  const name = path[path.length - 1]!;
  const where = [root.label, ...path.slice(0, -1)].join(' / ');
  const kind = documentKindInfo(name);
  if (kind) return { name: documentTitle(name), icon: kind.icon, href: hrefFor(root.scope, path), where, folder: false };
  if (type === LinkType.Dir) return { name, icon: 'i-lucide-folder text-warning', href: hrefFor(root.scope, path), where, folder: true };
  return { name, icon: `${fileIcon(name)} text-text-2`, href: hrefFor(root.scope, path), where, folder: false };
}

async function listing(cid: CID) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A folder whose blocks are not here is skipped rather than waited for.
    return await Promise.race([
      getTree().listDirectory(cid),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LISTING_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Start reading the trees not read yet. Trees that have changed are read again. */
export function startDriveSearch(roots: DriveSearchRoot[]): void {
  const wanted = new Set(roots.map(walkKey));
  for (const key of walks.keys()) {
    if (!wanted.has(key)) walks.delete(key);
  }
  for (const root of roots) {
    const key = walkKey(root);
    if (walks.has(key)) continue;
    const state: Walk = { items: [], done: false };
    walks.set(key, state);
    void walkInParallel(root, state);
  }
}

async function walkInParallel(root: DriveSearchRoot, state: Walk): Promise<void> {
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
        void listing(folder.cid).then((entries) => {
          const all = entries ?? [];
          // A shared folder is found by its name; a shared document by its own entry.
          if (root.shared && folder.path.length === 0 && !all.some((entry) => documentKindInfo(entry.name))) {
            state.items.push({ name: root.label, icon: 'i-lucide-folder text-warning', href: hrefFor(root.scope, []), where: 'Shared', folder: true });
          }
          for (const entry of all) {
            if (isHiddenDirectoryName(entry.name)) continue;
            const path = [...folder.path, entry.name];
            if (skip.has(path.join('/'))) continue;
            state.items.push(itemFor(root, path, entry.type));
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

/** Whether every tree has been read as far as the walk goes. */
export function driveSearchDone(roots: DriveSearchRoot[]): boolean {
  return roots.every((root) => walks.get(walkKey(root))?.done ?? false);
}

function rank(item: DriveSearchItem, query: string): number {
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s._-]+/).some((word) => word.startsWith(query))) return 2;
  return 3;
}

/** The names found so far that contain the query, best matches first. */
export function searchDrive(roots: DriveSearchRoot[], query: string, limit = 20): DriveSearchItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  const matches: Array<{ item: DriveSearchItem; score: number }> = [];
  for (const root of roots) {
    for (const item of walks.get(walkKey(root))?.items ?? []) {
      if (seen.has(item.href) || !item.name.toLowerCase().includes(needle)) continue;
      seen.add(item.href);
      matches.push({ item, score: rank(item, needle) });
    }
  }
  return matches
    .sort((a, b) => a.score - b.score
      || Number(b.item.folder) - Number(a.item.folder)
      || a.item.where.length - b.item.where.length
      || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map(({ item }) => item);
}
