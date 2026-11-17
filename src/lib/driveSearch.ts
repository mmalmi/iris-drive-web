/**
 * Search over the person's own Drive: the names of files, folders and
 * documents in My Drive and in the shared folders this device holds, as the
 * walk in driveWalk.ts finds them.
 */
import { LinkType, type TreeEntry } from '@hashtree/core';
import { fileIcon } from './fileIcon';
import { documentKindInfo, documentTitle, type DocumentKind } from './documentNames';
import { isAudioMediaFileName, isVideoMediaFileName } from './playableMedia';
import { driveHref, driveWalk, driveWalkDone, onDriveWalkProgress, startDriveWalk, type DriveFound, type DriveRoot } from './driveWalk';

export type DriveSearchRoot = DriveRoot;

export type SearchFileType = 'folder' | DocumentKind | 'pdf' | 'image' | 'video' | 'audio' | 'other';
export const fileTypeLabels: Record<SearchFileType, string> = {
  folder: 'Folders', document: 'Documents', sheet: 'Spreadsheets', slides: 'Presentations', form: 'Forms',
  pdf: 'PDFs', image: 'Images', video: 'Videos', audio: 'Audio', other: 'Other files',
};

export interface SearchFolder {
  scope: string;
  path: string[];
  /** Shared folders rooted beneath this folder in My Drive, each with its own route. */
  nestedShares: string[];
}

interface SearchFilter {
  folder?: SearchFolder | null;
  type?: SearchFileType | '';
}

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

/** Ask for the next batch only when the full results have been requested. */
export function hasMoreFolders(roots: DriveRoot[], readMore: boolean): boolean {
  let more = false;
  for (const root of roots) {
    const next = driveWalk(root)?.more;
    if (next) {
      more = true;
      if (readMore) next();
    }
  }
  return more;
}

function typeOf(entry: TreeEntry): SearchFileType {
  const name = entry.name.toLowerCase();
  if (entry.type === LinkType.Dir) return documentKindInfo(name)?.kind ?? 'folder';
  if (name.endsWith('.pdf')) return 'pdf';
  if (isAudioMediaFileName(name)) return 'audio';
  if (isVideoMediaFileName(name)) return 'video';
  if (/\.(?:jpe?g|jfif|png|gif|webp|svg|ico|bmp|avif|heic|heif|tiff?)$/.test(name)) return 'image';
  if (/\.(?:docx?|odt|rtf|txt|md|markdown|rst)$/.test(name)) return 'document';
  if (/\.(?:xlsx?|ods|csv|tsv)$/.test(name)) return 'sheet';
  if (/\.(?:pptx?|odp)$/.test(name)) return 'slides';
  return 'other';
}

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
function* itemsOf(root: DriveRoot, needle: string, { folder, type }: SearchFilter): Generator<DriveSearchItem> {
  const walk = driveWalk(root);
  if (!walk || (folder && folder.scope !== root.scope && !folder.nestedShares.includes(root.scope))) return;
  // A shared folder is found by its name; a shared document by its own entry.
  if (folder?.scope !== root.scope && (!type || type === 'folder') && root.shared && walk.topListed && root.label.toLowerCase().includes(needle)
    && !walk.found.some(({ path, entry }) => path.length === 1 && documentKindInfo(entry.name))) {
    yield { name: root.label, icon: 'i-lucide-folder text-warning', href: driveHref(root.scope, []), where: 'Shared', folder: true };
  }
  for (const found of walk.found) {
    if (folder?.scope === root.scope && (found.path.length <= folder.path.length
      || !folder.path.every((part, i) => found.path[i] === part))) continue;
    if (type && typeOf(found.entry) !== type) continue;
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
export function searchDrive(roots: DriveRoot[], query: string, limit = 20, filter: SearchFilter = {}): DriveSearchItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle && !filter.folder && !filter.type) return [];
  const seen = new Set<string>();
  const matches: Array<{ item: DriveSearchItem; score: number }> = [];
  for (const root of roots) {
    for (const item of itemsOf(root, needle, filter)) {
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
