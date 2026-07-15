import type { AppType } from '../appType';
import { canUseSameOriginHtreeProtocolStreaming, getInjectedHtreeServerUrl } from './nativeHtree';

export type ShareUrlOptionId = 'web' | 'htree';

export interface ShareUrlOption {
  id: ShareUrlOptionId;
  label: string;
  url: string;
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
