/**
 * Service Worker with File Streaming Support
 *
 * Intercepts file requests and streams data from main thread:
 * - /htree/{npub}/{treeName}/{path} - Npub-based file access
 * - /htree/{nhash}/{filename} - Direct nhash access (content-addressed)
 *
 * Routes are namespaced under /htree/ for reusability across apps.
 */

/// <reference lib="webworker" />
import { getRawHtreePath, parseImmutableHtreePath, parseMutableHtreePath } from '@hashtree/worker/htree-path';
import { precacheAndRoute } from 'workbox-precaching';
import { shouldInterceptHtreeRequestForWorker } from './lib/swRoutePolicy';
import { getSameOriginResponseMode } from './lib/swSameOriginPolicy';
import {
  buildImmutableFileRequest,
  buildMutableFileRequest,
} from './lib/swFileRequest';
import { createSwFileBridge } from './lib/swFileBridge';
import { getCachedHtreeMedia, serveHtreeMedia } from './lib/swHtreeMediaCache';
import { guessMimeType } from './lib/swMime';
import { addCORPHeader, addCORSHeaders, addCrossOriginHeaders } from './lib/swResponseHeaders';

declare let self: ServiceWorkerGlobalScope;

const isTestMode = !!import.meta.env.VITE_TEST_MODE;
const isLocalDevServer = Boolean(
  !isTestMode
    && import.meta.env.DEV
    && self.location.protocol === 'http:'
    && ['localhost', '127.0.0.1'].includes(self.location.hostname)
    && ['5173', '5174'].includes(self.location.port),
);

if (isTestMode || isLocalDevServer) {
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      if (isLocalDevServer) {
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(clients.map(client => client.navigate(client.url).catch(() => undefined)));
        return;
      }
      await self.clients.claim();
    })());
  });
}

let requestId = 0;

const NPUB_PATTERN = /^npub1[a-z0-9]{58}$/;
const PORT_TIMEOUT = 20000;
const STREAM_INACTIVITY_TIMEOUT = 45000;
const PORT_REGISTRATION_WAIT_MS = 8000;
const PORT_REGISTRATION_RETRY_WAIT_MS = 3000;
const PORT_REGISTRATION_INTERVAL_MS = 50;

const fileBridge = createSwFileBridge({
  selfScope: self,
  portTimeoutMs: PORT_TIMEOUT,
  streamInactivityTimeoutMs: STREAM_INACTIVITY_TIMEOUT,
  portRegistrationWaitMs: PORT_REGISTRATION_WAIT_MS,
  portRegistrationRetryWaitMs: PORT_REGISTRATION_RETRY_WAIT_MS,
  portRegistrationIntervalMs: PORT_REGISTRATION_INTERVAL_MS,
});
fileBridge.registerMessageHandler();

async function createNpubFileResponse(
  npub: string,
  treeName: string,
  filePath: string,
  rangeHeader: string | null,
  forceDownload: boolean,
  clientId?: string | null,
  clientKey?: string | null,
  referrer?: string | null,
): Promise<Response> {
  const id = `file_${++requestId}`;
  const mimeType = guessMimeType(filePath || treeName);
  const request = buildMutableFileRequest({
    requestId: id,
    npub,
    treeName,
    filePath,
    rangeHeader,
    mimeType,
    forceDownload,
  });

  return fileBridge.serveFile(request, clientId, clientKey, referrer).catch((error) => {
    console.error('[SW] File request failed:', error);
    return new Response(`File request failed: ${error.message}`, { status: 500 });
  });
}

async function createNhashFileResponse(
  nhash: string,
  filename: string,
  rangeHeader: string | null,
  forceDownload: boolean,
  clientId?: string | null,
  clientKey?: string | null,
  referrer?: string | null,
): Promise<Response> {
  const id = `file_${++requestId}`;
  const mimeType = guessMimeType(filename);
  const request = buildImmutableFileRequest({
    requestId: id,
    nhash,
    filePath: filename,
    rangeHeader,
    mimeType,
    forceDownload,
  });

  return fileBridge.serveFile(request, clientId, clientKey, referrer).catch((error) => {
    console.error('[SW] File request failed:', error);
    return new Response(`File request failed: ${error.message}`, { status: 500 });
  });
}

async function fetchSameOriginWithCache(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  return fetch(request);
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  const rawPath = getRawHtreePath(url);
  const pathParts = rawPath.slice(1).split('/');
  const rangeHeader = event.request.headers.get('Range');
  const clientKey = url.searchParams.get('htree_c');
  const requestDestination = event.request.destination || null;

  if (event.request.method !== 'GET') return;

  if (pathParts[0] === 'htree') {
    if (!shouldInterceptHtreeRequestForWorker(rawPath, clientKey, rangeHeader, requestDestination)) {
      event.respondWith(
        getCachedHtreeMedia(event.request).then(cached => (
          cached ? addCORSHeaders(cached) : fetchSameOriginWithCache(event.request)
        )),
      );
      return;
    }

    const immutablePath = parseImmutableHtreePath(rawPath);
    if (immutablePath) {
      const { nhash, filePath } = immutablePath;
      const filename = filePath || 'file';
      const forceDownload = url.searchParams.get('download') === '1';
      event.respondWith(
        serveHtreeMedia(event.request, () => (
          createNhashFileResponse(
            nhash,
            filename,
            rangeHeader,
            forceDownload,
            event.clientId,
            clientKey,
            event.request.referrer,
          )
        ), !clientKey && !rangeHeader, event).then(addCORSHeaders),
      );
      return;
    }

    const mutablePath = parseMutableHtreePath(rawPath);
    if (mutablePath && NPUB_PATTERN.test(mutablePath.npub)) {
      const { npub, treeName, filePath } = mutablePath;
      const forceDownload = url.searchParams.get('download') === '1';
      event.respondWith(
        serveHtreeMedia(event.request, () => (
          createNpubFileResponse(
            npub,
            treeName,
            filePath,
            rangeHeader,
            forceDownload,
            event.clientId,
            clientKey,
            event.request.referrer,
          )
        ), !clientKey && !rangeHeader, event).then(addCORSHeaders),
      );
      return;
    }
  }

  if (url.origin === self.location.origin) {
    if (isLocalDevServer) {
      event.respondWith(fetch(event.request));
      return;
    }

    const mode = getSameOriginResponseMode(event.request);
    if (mode === 'document-coi') {
      event.respondWith(fetch(event.request).then(addCrossOriginHeaders));
      return;
    }

    if (mode === 'subresource-corp') {
      event.respondWith(fetchSameOriginWithCache(event.request).then(addCORPHeader));
      return;
    }

    event.respondWith(fetchSameOriginWithCache(event.request));
  }
});

if (!isLocalDevServer) {
  self.addEventListener('install', () => {
    console.log('[SW] Installing...');
    self.skipWaiting();
  });

  self.addEventListener('activate', (event: ExtendableEvent) => {
    console.log('[SW] Activating...');
    event.waitUntil(self.clients.claim());
  });
}

if (!isTestMode && !isLocalDevServer) {
  precacheAndRoute(self.__WB_MANIFEST);
}
