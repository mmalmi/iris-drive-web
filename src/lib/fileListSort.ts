/**
 * The order of a folder's list: by name, last change or size, either way,
 * with folders above files as in Google Drive. A document is a folder inside
 * but a file to the person, so it sorts among the files. The choice is kept
 * on this device.
 */
import { LinkType, type TreeEntry } from '@hashtree/core';
import { isDocumentFolderName } from './documentNames';
import { modifiedAt } from './modifiedAt';

export type SortKey = 'name' | 'modified' | 'size';

export interface ListSort {
  by: SortKey;
  descending: boolean;
}

export const DEFAULT_SORT: ListSort = { by: 'name', descending: false };

const STORAGE_KEY = 'iris-drive:list-sort';
const KEYS: SortKey[] = ['name', 'modified', 'size'];

const isFolder = (entry: TreeEntry) => entry.type === LinkType.Dir && !isDocumentFolderName(entry.name);

const byName = (a: TreeEntry, b: TreeEntry) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** What is compared, before the name: nothing for a name sort. */
function value(entry: TreeEntry, by: SortKey): number {
  if (by === 'modified') return modifiedAt(entry) ?? 0;
  if (by === 'size') return entry.type === LinkType.Dir ? -1 : entry.size;
  return 0;
}

export function sortEntries(entries: TreeEntry[], sort: ListSort): TreeEntry[] {
  const direction = sort.descending ? -1 : 1;
  return [...entries].sort((a, b) => {
    const folderFirst = Number(isFolder(b)) - Number(isFolder(a));
    if (folderFirst) return folderFirst;
    if (sort.by === 'name') return direction * byName(a, b);
    return direction * (value(a, sort.by) - value(b, sort.by)) || byName(a, b);
  });
}

type SortStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function loadSort(storage: SortStorage = localStorage): ListSort {
  try {
    const kept = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null') as Partial<ListSort> | null;
    if (kept && KEYS.includes(kept.by as SortKey)) return { by: kept.by as SortKey, descending: kept.descending === true };
  } catch {
    // Storage may be blocked or hold something else; the usual order then.
  }
  return DEFAULT_SORT;
}

export function saveSort(sort: ListSort, storage: SortStorage = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Not kept, then: it still applies until the page is closed.
  }
}
