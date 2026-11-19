import type { TreeEntry } from '@hashtree/core';

export const OWNER_META = 'iris_file_owner';
export const REQUEST_META = 'iris_file_return';
export const RETURNED_META = 'iris_returned_from';

/** A request applies only to the file at its original location. */
export function withoutReturnRequest(meta: TreeEntry['meta']): TreeEntry['meta'] {
  if (!meta || !(REQUEST_META in meta)) return meta;
  const result = { ...meta };
  delete result[REQUEST_META];
  return result;
}
