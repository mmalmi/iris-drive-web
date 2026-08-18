import type { AppType } from '../appType';
import { canUseSameOriginHtreeProtocolStreaming, getInjectedHtreeServerUrl } from './nativeHtree';

export type ShareUrlOptionId = 'web' | 'htree';
export type ShareLinkVariantId = 'snapshot' | 'latest';

export interface ShareUrlOption {
  id: ShareUrlOptionId;
  label: string;
  url: string;
}

export interface ShareLinkVariant {
  id: ShareLinkVariantId;
  label: string;
  url: string;
}

export interface DriveShareLinkOptions {
  permalinkUrl: string | null;
  currentUrl: string;
  routeScope: string | null;
  isPermalink: boolean;
}

const DISTRIBUTED_APP_OWNER = 'npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm';

const WEB_APP_URLS: Record<AppType, string> = {
  files: 'https://drive.iris.to',
};

const HTREE_APP_NAMES: Record<AppType, string> = {
  files: 'drive',
};

const GIT_WEB_APP_URL = 'https://git.iris.to';
const GIT_HTREE_APP_NAME = 'git';

function normalizeHashSuffix(hashSuffix: string): string {
  if (!hashSuffix || hashSuffix === '#' || hashSuffix === '#/') {
    return '';
  }
  return hashSuffix.startsWith('#') ? hashSuffix : `#${hashSuffix}`;
}

function extractHashSuffix(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex === -1) return '';
  return normalizeHashSuffix(trimmed.slice(hashIndex));
}

function withoutHashQueryParam(rawUrl: string, name: string): string {
  const hashIndex = rawUrl.indexOf('#');
  const prefix = hashIndex === -1 ? '' : rawUrl.slice(0, hashIndex);
  const hash = hashIndex === -1 ? rawUrl : rawUrl.slice(hashIndex);
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return rawUrl;

  const path = hash.slice(0, queryIndex);
  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  params.delete(name);
  const query = params.toString();
  return `${prefix}${path}${query ? `?${query}` : ''}`;
}

function sameShareTarget(first: string, second: string): boolean {
  const firstHash = extractHashSuffix(first);
  const secondHash = extractHashSuffix(second);
  if (firstHash || secondHash) return firstHash === secondHash;
  return first.trim() === second.trim();
}

/**
 * Build the link choices shown when sharing a Drive file or folder.
 *
 * UUID profile routes are device/profile lookup scopes, not portable public
 * owner addresses. They must never escape through the share UI. Their
 * content-addressed snapshot remains independently shareable.
 */
export function createDriveShareLinkVariants(options: DriveShareLinkOptions): ShareLinkVariant[] {
  const variants: ShareLinkVariant[] = [];
  const permalinkUrl = options.permalinkUrl?.trim() || null;
  const currentUrl = withoutHashQueryParam(options.currentUrl.trim(), 'edit');

  if (permalinkUrl) {
    variants.push({ id: 'snapshot', label: 'Snapshot', url: permalinkUrl });
  }

  const currentRouteIsShareable = options.isPermalink || options.routeScope?.startsWith('npub1');
  if (
    currentRouteIsShareable
    && currentUrl
    && (!permalinkUrl || !sameShareTarget(permalinkUrl, currentUrl))
  ) {
    variants.push({ id: 'latest', label: 'Latest', url: currentUrl });
  }

  return variants;
}

export function getDefaultWebAppUrl(appType: AppType): string {
  return WEB_APP_URLS[appType];
}

export function getDefaultHtreeAppUrl(appType: AppType): string {
  return `htree://${DISTRIBUTED_APP_OWNER}/${HTREE_APP_NAMES[appType]}`;
}

function shouldUseHtreeRepositoryUrl(): boolean {
  return canUseSameOriginHtreeProtocolStreaming() || !!getInjectedHtreeServerUrl();
}

export function getCanonicalGitRepositoryUrl(repoPath = 'iris-drive-web'): string {
  const normalizedPath = repoPath
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  const baseUrl = shouldUseHtreeRepositoryUrl()
    ? `htree://${DISTRIBUTED_APP_OWNER}/${GIT_HTREE_APP_NAME}/#/${DISTRIBUTED_APP_OWNER}`
    : `${GIT_WEB_APP_URL}/#/${DISTRIBUTED_APP_OWNER}`;
  return normalizedPath
    ? `${baseUrl}/${normalizedPath}`
    : baseUrl;
}

export function createShareUrlOptions(appType: AppType, rawUrl: string): ShareUrlOption[] {
  const hashSuffix = extractHashSuffix(rawUrl);
  return [
    {
      id: 'web',
      label: 'Web URL',
      url: hashSuffix ? `${getDefaultWebAppUrl(appType)}/${hashSuffix}` : getDefaultWebAppUrl(appType),
    },
    {
      id: 'htree',
      label: 'htree URL',
      url: `${getDefaultHtreeAppUrl(appType)}${hashSuffix}`,
    },
  ];
}
