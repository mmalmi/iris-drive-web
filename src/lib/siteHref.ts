import { nhashEncode, type CID } from '@hashtree/core';

const SITES_WEB_BASE_URL = 'https://sites.iris.to';
const AUTO_RELOAD_QUERY = 'reload=1';

interface HashParamsLike {
  get(name: string): string | null;
}

export interface SiteRouteLike {
  npub?: string | null;
  treeName?: string | null;
  path: string[];
  isPermalink?: boolean;
  params?: HashParamsLike | null;
}

interface BuildSitesHrefOptions {
  route: SiteRouteLike;
  entryPath: string;
  siteRootPath?: string[];
  siteRootCid?: CID | null;
  autoReloadMutable?: boolean;
}

function encodePathForHash(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function canUseMutableSiteRoute(route: SiteRouteLike): route is SiteRouteLike & { npub: string; treeName: string } {
  return Boolean(route.npub && route.treeName && !route.isPermalink && !route.params?.get('k'));
}

export function isHtmlFilename(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return ext === 'html' || ext === 'htm';
}

export function findDirectorySiteEntry(entries: Array<{ name: string }>): string | null {
  const htmlIndex = entries.find((entry) => entry.name.toLowerCase() === 'index.html');
  if (htmlIndex) return htmlIndex.name;

  const htmIndex = entries.find((entry) => entry.name.toLowerCase() === 'index.htm');
  return htmIndex?.name ?? null;
}

export function buildSitesHref({
  route,
  entryPath,
  siteRootPath = [],
  siteRootCid = null,
  autoReloadMutable = false,
}: BuildSitesHrefOptions): string {
  const encodedEntryPath = encodePathForHash(entryPath || 'index.html');
  if (!encodedEntryPath) return '';

  if (canUseMutableSiteRoute(route)) {
    const siteTreeName = [route.treeName, ...siteRootPath].filter(Boolean).join('/');
    const query = autoReloadMutable ? `?${AUTO_RELOAD_QUERY}` : '';
    return `${SITES_WEB_BASE_URL}/#/${encodeURIComponent(route.npub)}/${encodeURIComponent(siteTreeName)}/${encodedEntryPath}${query}`;
  }

  if (!siteRootCid) return '';
  return `${SITES_WEB_BASE_URL}/#/${nhashEncode(siteRootCid)}/${encodedEntryPath}`;
}
