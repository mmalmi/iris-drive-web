/// <reference lib="webworker" />

const HTREE_MEDIA_CACHE = 'htree-media-v1';
const MAX_CACHEABLE_HTREE_MEDIA_BYTES = 20 * 1024 * 1024;

function getNormalizedHtreeMediaCacheRequest(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.delete('htree_c');
  url.searchParams.delete('htree_img_retry');
  return new Request(url.toString(), { method: 'GET' });
}

function isCacheableHtreeMediaRequest(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === 'GET'
    && url.pathname.startsWith('/htree/')
    && !request.headers.has('Range')
    && url.searchParams.get('download') !== '1';
}

function isCacheableHtreeMediaResponse(response: Response): boolean {
  if (response.status !== 200) {
    return false;
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    return false;
  }

  const contentLength = response.headers.get('Content-Length');
  if (!contentLength) {
    return false;
  }

  const byteLength = Number.parseInt(contentLength, 10);
  return Number.isFinite(byteLength) && byteLength <= MAX_CACHEABLE_HTREE_MEDIA_BYTES;
}

export async function getCachedHtreeMedia(request: Request): Promise<Response | null> {
  if (!isCacheableHtreeMediaRequest(request)) {
    return null;
  }

  const cache = await caches.open(HTREE_MEDIA_CACHE);
  return await cache.match(getNormalizedHtreeMediaCacheRequest(request)) ?? null;
}

function cacheHtreeMedia(request: Request, response: Response, event?: ExtendableEvent): Response {
  if (!isCacheableHtreeMediaRequest(request) || !isCacheableHtreeMediaResponse(response)) {
    return response;
  }

  const cacheRequest = getNormalizedHtreeMediaCacheRequest(request);
  const cacheResponse = response.clone();
  const cachePromise = caches.open(HTREE_MEDIA_CACHE)
    .then(cache => cache.put(cacheRequest, cacheResponse))
    .catch(error => console.warn('[SW] Failed to cache /htree media response:', error));

  event?.waitUntil(cachePromise);
  if (!event) {
    void cachePromise;
  }

  return response;
}

export async function serveHtreeMedia(
  request: Request,
  createResponse: () => Promise<Response>,
  preferCached: boolean,
  event?: ExtendableEvent,
): Promise<Response> {
  if (preferCached) {
    const cached = await getCachedHtreeMedia(request);
    if (cached) {
      return cached;
    }
  }

  return cacheHtreeMedia(request, await createResponse(), event);
}
