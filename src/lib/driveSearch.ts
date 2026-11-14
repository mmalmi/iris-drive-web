/**
 * Search over the person's own Drive: the names of files, folders and
 * documents in My Drive and in the shared folders this device holds, as the
 * walk in driveWalk.ts finds them.
 */
import { LinkType } from '@hashtree/core';
import { fileIcon } from './fileIcon';
import { documentKindInfo, documentTitle } from './documentNames';
import { driveHref, driveWalk, driveWalkDone, onDriveWalkProgress, startDriveWalk, type DriveFound, type DriveRoot } from './driveWalk';

export type DriveSearchRoot = DriveRoot;

export interface DriveSearchItem {
  name: string;
  icon: string;
  href: string;
  /** Where it is: the tree's label and the folders above it. */
  where: string;
  folder: boolean;
}

export const startDriveSearch = startDriveWalk;
export const driveSearchDone = driveWalkDone;
export const onDriveSearchProgress = onDriveWalkProgress;

function itemFor(root: DriveRoot, { path, entry }: DriveFound): DriveSearchItem {
  const name = entry.name;
  const href = driveHref(root.scope, path);
  const where = [root.label, ...path.slice(0, -1)].join(' / ');
  const kind = documentKindInfo(name);
  if (kind) return { name: documentTitle(name), icon: kind.icon, href, where, folder: false };
  if (entry.type === LinkType.Dir) return { name, icon: 'i-lucide-folder text-warning', href, where, folder: true };
  return { name, icon: `${fileIcon(name)} text-text-2`, href, where, folder: false };
}

/** The name an entry is found by: a document's title, anything else its name. */
function shownName(name: string): string {
  return documentKindInfo(name) ? documentTitle(name) : name;
}

/** Everything a tree has been found to hold, as search shows it. */
function* itemsOf(root: DriveRoot, needle: string): Generator<DriveSearchItem> {
  const walk = driveWalk(root);
  if (!walk) return;
  // A shared folder is found by its name; a shared document by its own entry.
  if (root.shared && walk.topListed && root.label.toLowerCase().includes(needle)
    && !walk.found.some(({ path, entry }) => path.length === 1 && documentKindInfo(entry.name))) {
    yield { name: root.label, icon: 'i-lucide-folder text-warning', href: driveHref(root.scope, []), where: 'Shared', folder: true };
  }
  for (const found of walk.found) {
    if (shownName(found.entry.name).toLowerCase().includes(needle)) yield itemFor(root, found);
  }
}

function rank(item: DriveSearchItem, query: string): number {
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/[\s._-]+/).some((word) => word.startsWith(query))) return 2;
  return 3;
}

/** The names found so far that contain the query, best matches first. */
export function searchDrive(roots: DriveRoot[], query: string, limit = 20): DriveSearchItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const seen = new Set<string>();
  const matches: Array<{ item: DriveSearchItem; score: number }> = [];
  for (const root of roots) {
    for (const item of itemsOf(root, needle)) {
      if (seen.has(item.href)) continue;
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
