import { buildTreeEventPermalink } from '../lib/treeEventSnapshots';
import { COPY_NAME_PARAM, contentHref } from '../lib/shareUrls';

/**
 * The address of the file or folder at `path` of the place being browsed:
 * in a signed snapshot, in a tree by its owner and name, or in a read-only
 * copy by its content.
 */
export function buildPathHref(options: {
  path: string[];
  currentNpub: string | null;
  currentTreeName: string | null;
  rootCid: { hash: Uint8Array; key?: Uint8Array } | null;
  linkKey: string | null;
  snapshot: Parameters<typeof buildTreeEventPermalink>[0] | null;
  /** The name a read-only copy of a folder opens under, kept while going through it. */
  rootName?: string | null;
}): string {
  const { path, currentNpub, currentTreeName, rootCid, linkKey, snapshot, rootName } = options;
  if (snapshot) return buildTreeEventPermalink(snapshot, path, linkKey);
  const parts = path.map(encodeURIComponent);
  const key = linkKey ? `k=${linkKey}` : '';
  if (currentNpub && currentTreeName) {
    return `#/${[encodeURIComponent(currentNpub), encodeURIComponent(currentTreeName), ...parts].join('/')}${key && `?${key}`}`;
  }
  if (rootCid?.hash) {
    const query = [key, rootName ? `${COPY_NAME_PARAM}=${encodeURIComponent(rootName)}` : ''].filter(Boolean).join('&');
    return [contentHref(rootCid), ...parts].join('/') + (query && `?${query}`);
  }
  return `#/${parts.join('/')}${key && `?${key}`}`;
}
