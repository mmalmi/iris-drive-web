/**
 * File URL Helper
 *
 * Generates URLs for streaming files through the service worker (web)
 * or native HTTP server (Tauri desktop).
 *
 * URL formats:
 * - Web:   /htree/{npub}/{treeName}/{path} or /htree/{nhash}/{filename}
 * - Tauri: http://127.0.0.1:21417/htree/{...} (same path structure, fixed port)
 */

import { nhashDecode, nhashEncode, type CID } from '@hashtree/core';
import { logHtreeDebug } from './htreeDebug';
import {
  getHtreeRuntime,
  getRuntimeHtreeServerUrl,
  isSameOriginIrisGatewayRuntime,
} from './htreeRuntime';
import { canUseInjectedHtreeServerUrl } from './nativeHtree';
import { PREFERRED_PLAYABLE_MEDIA_FILENAMES } from './playableMedia';

const LOCAL_PROBE_TIMEOUT_MS = 500;
const LOCAL_PROBE_INTERVAL_MS = 1000;
const PREFIX_READY_TIMEOUT_MS = 15000;
const COMMON_THUMBNAIL_FILENAMES = ['thumbnail.jpg', 'thumbnail.webp', 'thumbnail.png', 'thumbnail.jpeg'] as const;
const PUBLIC_HTREE_HTTP_BASE_URL = 'https://upload.iris.to';

let cachedPrefix = '';
const prefixListeners = new Set<(prefix: string) => void>();
let localProbePromise: Promise<boolean> | null = null;
let prefixReady = false;
let prefixEpoch = 0;

function isLocalHtreePrefix(prefix: string): boolean {
  // Treat loopback URLs and local Iris gateway origins as local prefixes.
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(prefix)
    || /^http:\/\/([^/]+\.)?iris\.localhost(:\d+)?$/.test(prefix);
}

function allowLocalPrefix(): boolean {
  return canUseInjectedHtreeServerUrl() || isSameOriginIrisGatewayRuntime();
}

async function probeLocalHtreeServer(baseUrl: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (localProbePromise) return localProbePromise;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);

  localProbePromise = fetch(`${baseUrl}/htree/test`, {
    method: 'HEAD',
    signal: controller.signal,
  })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      clearTimeout(timeout);
      localProbePromise = null;
    });

  return localProbePromise;
}

function notifyPrefixReady(source: string): void {
  if (prefixReady) return;
  if (!cachedPrefix) return;
  prefixReady = true;
  prefixEpoch += 1;
  logHtreeDebug('prefix:ready', { prefix: cachedPrefix, source, epoch: prefixEpoch });
  prefixListeners.forEach((callback) => {
    try {
      callback(cachedPrefix);
    } catch (err) {
      console.warn('[mediaUrl] Failed to notify prefix listener:', err);
    }
  });
  prefixListeners.clear();
}

function updateCachedPrefix(next: string, source: string): void {
  const normalized = next.trim().replace(/\/$/, '');
  if (normalized === cachedPrefix) return;
  cachedPrefix = normalized;
  logHtreeDebug('prefix:update', { prefix: normalized, source });
}

function getHtreeServerOverride(): string | null {
  return getRuntimeHtreeServerUrl();
}

/**
 * Get the URL prefix based on runtime environment
 * - Web: "" (uses relative /htree paths, service worker intercepts)
 * - Tauri: http://127.0.0.1:21417 (fixed htree server URL)
 */
export function getHtreePrefix(): string {
  const override = getHtreeServerOverride();
  if (override && allowLocalPrefix()) {
    updateCachedPrefix(override, 'override');
    if (!prefixReady && !isLocalHtreePrefix(cachedPrefix)) {
      notifyPrefixReady('override');
    }
    return cachedPrefix;
  }
  const allowLocal = allowLocalPrefix();
  if (cachedPrefix) {
    if (!isLocalHtreePrefix(cachedPrefix) || allowLocal) {
      return cachedPrefix;
    }
    cachedPrefix = '';
    prefixReady = false;
    prefixEpoch = 0;
  }
  if (typeof window !== 'undefined' && window.htree?.htreeBaseUrl) {
    const prefix = window.htree.htreeBaseUrl;
    if (typeof prefix === 'string' && prefix.trim()) {
      const normalized = prefix.trim().replace(/\/$/, '');
      if (!isLocalHtreePrefix(normalized) || allowLocal) {
        updateCachedPrefix(normalized, 'window.htree');
        if (!prefixReady && !isLocalHtreePrefix(cachedPrefix)) {
          notifyPrefixReady('window.htree');
        }
        return cachedPrefix;
      }
    }
  }
  return '';
}

/**
 * Async version for compatibility - just returns sync result
 */
export async function getHtreePrefixAsync(): Promise<string> {
  const prefix = getHtreePrefix();
  if (!isLocalHtreePrefix(prefix)) {
    return prefix;
  }
  if (prefixReady) {
    return prefix;
  }
  void initHtreePrefix();
  return await new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve(prefix), PREFIX_READY_TIMEOUT_MS);
    onHtreePrefixReady((readyPrefix) => {
      clearTimeout(timeoutId);
      resolve(readyPrefix);
    });
  });
}

/**
 * Subscribe to prefix ready - fires when a usable prefix is confirmed.
 */
export function onHtreePrefixReady(callback: (prefix: string) => void): void {
  if (prefixReady && cachedPrefix) {
    callback(cachedPrefix);
    return;
  }
  prefixListeners.add(callback);
}

/**
 * Initialize htree prefix - waits for Tauri server to be reachable.
 */
export async function initHtreePrefix(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (prefixReady) return;
  const prefix = getHtreePrefix();
  if (prefix && !isLocalHtreePrefix(prefix)) {
    notifyPrefixReady('init');
    return;
  }
  if (!allowLocalPrefix()) {
    return;
  }

  // Native app sets __HTREE_SERVER_URL__; poll until the server is reachable.
  const override = getHtreeServerOverride();
  if (!override) return;

  const start = Date.now();
  const maxWaitMs = 60000;
  const intervalMs = 100;
  const maxAttempts = Math.ceil(maxWaitMs / intervalMs);
  let lastProbeAt = 0;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const nextPrefix = getHtreePrefix();
    if (nextPrefix && !isLocalHtreePrefix(nextPrefix)) {
      notifyPrefixReady('init');
      return;
    }
    const now = Date.now();
    if (now - lastProbeAt >= LOCAL_PROBE_INTERVAL_MS) {
      lastProbeAt = now;
      const reachable = await probeLocalHtreeServer(override);
      if (reachable) {
        updateCachedPrefix(override, 'local-probe');
        notifyPrefixReady('local-probe');
        return;
      }
    }
  }
  logHtreeDebug('prefix:init-timeout', { waitedMs: Math.round(Date.now() - start) });
}

export function appendHtreeCacheBust(url: string): string {
  if (!prefixEpoch) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}htree_p=${prefixEpoch}`;
}

function buildMutableMediaUrl(
  npub: string,
  treeName: string,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  let url = getHtreeRuntime().urls.request(
    { kind: 'mutable', npub, treeName, path },
    {
      mutableStyle: 'htree',
    },
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || `${value}`.trim() === '') {
      continue;
    }
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
  }
  return getHtreeRuntime().urls.appendClientId(url);
}

function buildImmutableMediaUrl(
  nhash: string,
  path = '',
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  let url = getHtreeRuntime().urls.request(
    { kind: 'immutable', nhash, path },
  );
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || `${value}`.trim() === '') {
      continue;
    }
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
  }
  return getHtreeRuntime().urls.appendClientId(url);
}

/**
 * Generate a file URL for npub-based access
 *
 * @param npub - The npub of the user
 * @param treeName - The tree name (e.g., 'public' or 'videos/My Video')
 * @param path - File path within the tree
 * @returns URL string like /htree/npub1.../public/video.mp4
 */
export function getNpubFileUrl(npub: string, treeName: string, path: string): string {
  return appendHtreeCacheBust(buildMutableMediaUrl(npub, treeName, path));
}

export function getPublicNpubFileUrl(npub: string, treeName: string, path: string): string {
  const encodedTreeName = encodeURIComponent(treeName);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${PUBLIC_HTREE_HTTP_BASE_URL}/${npub}/${encodedTreeName}/${encodedPath}`;
}

/**
 * Generate a file URL for npub-based access (async version)
 */
export async function getNpubFileUrlAsync(npub: string, treeName: string, path: string): Promise<string> {
  return getNpubFileUrl(npub, treeName, path);
}

interface StableFileUrlOptions {
  cid?: CID | null;
  npub?: string | null;
  treeName?: string | null;
  path: string;
}

export function getStableFileUrl(options: StableFileUrlOptions): string | null {
  if (options.cid) {
    const nhash = nhashEncode(options.cid);
    const fileName = options.path.split('/').filter(Boolean).at(-1) ?? 'file';
    return getEncodedNhashUrl(nhash, fileName);
  }
  if (options.npub && options.treeName) {
    return getNpubFileUrl(options.npub, options.treeName, options.path);
  }
  return null;
}

interface StablePathUrlOptions {
  rootCid?: CID | null;
  npub?: string | null;
  treeName?: string | null;
  path: string;
}

export function getStablePathUrl(options: StablePathUrlOptions): string | null {
  if (options.rootCid) {
    return appendHtreeCacheBust(buildImmutableMediaUrl(
      nhashEncode(options.rootCid),
      options.path,
    ));
  }
  if (options.npub && options.treeName) {
    return getNpubFileUrl(options.npub, options.treeName, options.path);
  }
  return null;
}

interface StableResolvedMediaUrlOptions {
  rootCid?: CID | null;
  cid?: CID | null;
  npub?: string | null;
  treeName?: string | null;
  path: string;
}

export function getStableResolvedMediaUrls(options: StableResolvedMediaUrlOptions): string[] {
  const urls = new Set<string>();
  const pathUrl = getStablePathUrl({
    rootCid: options.rootCid,
    npub: options.npub,
    treeName: options.treeName,
    path: options.path,
  });
  if (pathUrl) {
    urls.add(pathUrl);
  }
  const fileUrl = getStableFileUrl({
    cid: options.cid,
    npub: options.npub,
    treeName: options.treeName,
    path: options.path,
  });
  if (fileUrl) {
    urls.add(fileUrl);
  }
  return Array.from(urls);
}

export const COMMON_VIDEO_FILENAMES = PREFERRED_PLAYABLE_MEDIA_FILENAMES;

interface StableVideoCandidateUrlOptions {
  rootCid?: CID | null;
  npub?: string | null;
  treeName?: string | null;
  videoId?: string | null;
  videoPath?: string | null;
  includeCommonFallbacks?: boolean;
}

export function getStableVideoCandidateUrls(options: StableVideoCandidateUrlOptions): string[] {
  const urls = new Set<string>();

  const addPath = (path: string) => {
    const url = getStablePathUrl({
      rootCid: options.rootCid,
      npub: options.npub,
      treeName: options.treeName,
      path,
    });
    if (url) {
      urls.add(url);
    }
  };

  if (options.videoPath) {
    addPath(options.videoPath);
  } else {
    addPath(options.videoId ? `${options.videoId}/video` : 'video');
  }

  if (options.includeCommonFallbacks !== false && !options.videoPath) {
    const prefix = options.videoId ? `${options.videoId}/` : '';
    for (const fileName of COMMON_VIDEO_FILENAMES) {
      addPath(`${prefix}${fileName}`);
    }
  }

  return Array.from(urls);
}

export function getEncodedNhashUrl(nhash: string, filename?: string): string {
  return appendHtreeCacheBust(buildImmutableMediaUrl(nhash, filename ?? ''));
}

/**
 * Generate a file URL for direct nhash access (content-addressed)
 *
 * @param cid - The content ID (with Uint8Array fields)
 * @param filename - Optional filename (for MIME type detection)
 * @returns URL string like /htree/nhash1...
 */
export function getNhashFileUrl(cid: CID, filename?: string): string {
  const nhash = nhashEncode(cid);
  return getEncodedNhashUrl(nhash, filename);
}

/**
 * Legacy alias for getNhashFileUrl (backwards compatibility)
 */
export function getCidFileUrl(cid: CID, filename: string = 'file'): string {
  return getNhashFileUrl(cid, filename);
}

/**
 * Legacy alias for getNhashFileUrl (backwards compatibility)
 */
export function getMediaUrl(cid: CID, path: string = ''): string {
  return getNhashFileUrl(cid, path);
}

/**
 * Generate a thumbnail URL for a video/content
 *
 * @param npub - The npub of the owner
 * @param treeName - The tree name
 * @param videoId - Optional video ID subdirectory
 * @param hashPrefix - Optional hash prefix for cache busting
 * @returns URL string like /htree/npub1.../treeName/videoId/thumbnail?v=abc123
 */
export function getThumbnailUrl(npub: string, treeName: string, videoId?: string, hashPrefix?: string): string {
  const path = videoId
    ? `${videoId}/thumbnail`
    : 'thumbnail';
  return appendHtreeCacheBust(buildMutableMediaUrl(
    npub,
    treeName,
    path,
    hashPrefix ? { v: hashPrefix } : undefined,
  ));
}

/**
 * Generate an immutable thumbnail URL from a known root CID.
 *
 * This avoids mutable-tree resolution races when the caller already knows the
 * exact tree root from feed metadata.
 */
export function getThumbnailUrlFromCid(rootCid: CID, videoId?: string): string {
  const path = videoId
    ? `${videoId}/thumbnail`
    : 'thumbnail';
  return appendHtreeCacheBust(buildImmutableMediaUrl(nhashEncode(rootCid), path));
}

export function isThumbnailAliasUrl(url: string): boolean {
  return /\/thumbnail(?:[?#]|$)/.test(url) && !/\/thumbnail\.[^/?#]+(?:[?#]|$)/.test(url);
}

function getImmutableThumbnailAliasRootCid(url: string): CID | null {
  if (!isThumbnailAliasUrl(url)) {
    return null;
  }

  try {
    const parsed = new URL(url, 'http://localhost');
    const parts = parsed.pathname.split('/').filter(Boolean);
    const nhash = parts.find((part) => part.startsWith('nhash1'));
    if (!nhash) {
      return null;
    }
    return nhashDecode(nhash);
  } catch {
    return null;
  }
}

interface StableThumbnailUrlOptions {
  thumbnailUrl?: string | null;
  rootCid?: CID | null;
  npub?: string | null;
  treeName?: string | null;
  videoId?: string;
  hashPrefix?: string;
  allowAliasFallback?: boolean;
  preferAliasFallback?: boolean;
}

function isAllowedExplicitThumbnailUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
      return false;
    }
    if (parsed.protocol === 'htree:') {
      return true;
    }
    return parsed.pathname.includes('/htree/');
  } catch {
    return url.includes('/htree/');
  }
}

function appendImmutableThumbnailFileCandidates(
  urls: Set<string>,
  rootCid?: CID | null,
  videoId?: string,
): void {
  if (!rootCid) return;
  for (const fileName of COMMON_THUMBNAIL_FILENAMES) {
    const candidate = getStablePathUrl({
      rootCid,
      path: videoId ? `${videoId}/${fileName}` : fileName,
    });
    if (candidate) {
      urls.add(candidate);
    }
  }
}

export function getStableThumbnailCandidateUrls(options: StableThumbnailUrlOptions): string[] {
  const urls = new Set<string>();
  const rawExplicitThumbnailUrl = options.thumbnailUrl?.trim() || null;
  const explicitThumbnailUrl = rawExplicitThumbnailUrl && isAllowedExplicitThumbnailUrl(rawExplicitThumbnailUrl)
    ? rawExplicitThumbnailUrl
    : null;
  const explicitIsAlias = explicitThumbnailUrl ? isThumbnailAliasUrl(explicitThumbnailUrl) : false;
  const explicitImmutableAliasRootCid = explicitThumbnailUrl
    ? getImmutableThumbnailAliasRootCid(explicitThumbnailUrl)
    : null;
  const immutableAliasUrl = options.rootCid
    ? getThumbnailUrlFromCid(options.rootCid, options.videoId)
    : null;
  const canUseMutableAlias = options.allowAliasFallback !== false && !!options.npub && !!options.treeName;
  const mutableAliasUrl = canUseMutableAlias
    ? getThumbnailUrl(options.npub!, options.treeName!, options.videoId, options.hashPrefix)
    : null;

  if (explicitThumbnailUrl && !explicitIsAlias) {
    urls.add(explicitThumbnailUrl);
  }
  if (options.preferAliasFallback && mutableAliasUrl) {
    urls.add(mutableAliasUrl);
  }
  appendImmutableThumbnailFileCandidates(urls, explicitImmutableAliasRootCid, options.videoId);
  appendImmutableThumbnailFileCandidates(urls, options.rootCid, options.videoId);
  if (immutableAliasUrl) {
    urls.add(immutableAliasUrl);
  }
  if (explicitThumbnailUrl && explicitIsAlias) {
    urls.add(explicitThumbnailUrl);
  }
  if (!options.preferAliasFallback && mutableAliasUrl) {
    urls.add(mutableAliasUrl);
  }
  return Array.from(urls);
}

export function getStableThumbnailUrl(options: StableThumbnailUrlOptions): string | null {
  return getStableThumbnailCandidateUrls(options)[0] ?? null;
}

/**
 * Check if file streaming is available
 * - Tauri: Always available (server runs on fixed port)
 * - Web: Requires service worker to be ready
 */
export async function isFileStreamingAvailable(): Promise<boolean> {
  // If a direct local htree server can be used safely, streaming is ready.
  if (canUseInjectedHtreeServerUrl()) return true;

  // In browser, check service worker
  if (!('serviceWorker' in navigator)) return false;
  const registration = await navigator.serviceWorker.ready;
  return !!registration.active;
}
