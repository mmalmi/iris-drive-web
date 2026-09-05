export type PathKindSourceState = {
  metadataPresent: boolean;
  activeReplacementPaths: ReadonlySet<string>;
};

/**
 * A root that carries role metadata but no exact role at a collision says its
 * entry is not a kind replacement. Preserve the opposite active replacement
 * across an unrelated republish. Both-active, neither-active, and legacy pairs
 * deliberately fall back to ordinary causal ordering.
 */
export function preferredKindFromActiveRole(
  path: string,
  directorySourceKey: string,
  fileSourceKey: string,
  sourceStates: ReadonlyMap<string, PathKindSourceState>,
): 'directory' | 'file' | null {
  const directoryState = sourceStates.get(directorySourceKey);
  const fileState = sourceStates.get(fileSourceKey);
  const directoryHasRole = directoryState?.activeReplacementPaths.has(path) ?? false;
  const fileHasRole = fileState?.activeReplacementPaths.has(path) ?? false;

  if (directoryHasRole === fileHasRole) return null;
  if (directoryHasRole && fileState?.metadataPresent) return 'directory';
  if (fileHasRole && directoryState?.metadataPresent) return 'file';
  return null;
}
