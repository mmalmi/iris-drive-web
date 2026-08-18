import type { TreeEntry } from '@hashtree/core';

const RESERVED_METADATA_DIRECTORY = '.hashtree';

export function filterVisibleDirectoryEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.filter(({ name }) => name.toLowerCase() !== RESERVED_METADATA_DIRECTORY);
}
