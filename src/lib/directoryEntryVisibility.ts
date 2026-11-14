import type { TreeEntry } from '@hashtree/core';

/**
 * Folders the app keeps for itself and never lists: hashtree's metadata, and
 * where forms keep their keys and responses (see lib/forms/formStore.ts).
 */
export const HIDDEN_DIRECTORIES = new Set(['.hashtree', '.iris-forms']);

export function isHiddenDirectoryName(name: string): boolean {
  return HIDDEN_DIRECTORIES.has(name.toLowerCase());
}

export function filterVisibleDirectoryEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.filter(({ name }) => !isHiddenDirectoryName(name));
}
