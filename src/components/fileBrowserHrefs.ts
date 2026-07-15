import { nhashEncode, toHex, type LinkType } from '@hashtree/core';
import { buildTreeEventPermalink } from '../lib/treeEventSnapshots';

type RootCidForHref = { hash: Uint8Array; key?: Uint8Array } | null;
type TreeSnapshot = Parameters<typeof buildTreeEventPermalink>[0] | null;

function buildQueryString(params: { k?: string | null; g?: string | null }): string {
  const parts: string[] = [];
  if (params.k) parts.push(`k=${params.k}`);
  if (params.g !== null && params.g !== undefined) parts.push(`g=${encodeURIComponent(params.g)}`);
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

export function buildEntryHref(options: {
  entry: { name: string; type: LinkType };
  currentNpub: string | null;
  currentTreeName: string | null;
  currentPath: string[];
  rootCid: RootCidForHref;
  linkKey: string | null;
  gitRootPath: string | null;
  snapshot: TreeSnapshot;
}): string {
  const { entry, currentNpub, currentTreeName, currentPath, rootCid, linkKey, gitRootPath, snapshot } = options;
  const parts: string[] = [];
  const suffix = buildQueryString({ k: linkKey, g: gitRootPath });

  if (snapshot) return buildTreeEventPermalink(snapshot, [...currentPath, entry.name], linkKey);
  if (currentNpub && currentTreeName) {
    parts.push(currentNpub, currentTreeName, ...currentPath, entry.name);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  }
  if (rootCid?.hash) {
    const nhash = nhashEncode({
      hash: toHex(rootCid.hash),
      decryptKey: rootCid.key ? toHex(rootCid.key) : undefined,
    });
    parts.push(nhash, ...currentPath, entry.name);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  }

  parts.push(...currentPath, entry.name);
  return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
}

export function buildDirHref(options: {
  path: string[];
  currentNpub: string | null;
  currentTreeName: string | null;
  rootCid: RootCidForHref;
  linkKey: string | null;
  snapshot: TreeSnapshot;
}): string {
  const { path, currentNpub, currentTreeName, rootCid, linkKey, snapshot } = options;
  const parts: string[] = [];
  const suffix = linkKey ? `?k=${linkKey}` : '';

  if (snapshot) return buildTreeEventPermalink(snapshot, path, linkKey);
  if (currentNpub && currentTreeName) {
    parts.push(currentNpub, currentTreeName, ...path);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  }
  if (rootCid?.hash) {
    const nhash = nhashEncode({
      hash: toHex(rootCid.hash),
      decryptKey: rootCid.key ? toHex(rootCid.key) : undefined,
    });
    parts.push(nhash, ...path);
    return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
  }

  parts.push(...path);
  return '#/' + parts.map(encodeURIComponent).join('/') + suffix;
}

export function buildTreeHref(ownerNpub: string, treeName: string, linkKey?: string): string {
  const base = `#/${encodeURIComponent(ownerNpub)}/${encodeURIComponent(treeName)}`;
  return linkKey ? `${base}?k=${linkKey}` : base;
}
