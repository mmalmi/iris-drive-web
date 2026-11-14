/**
 * The app's own files (assets/, named by their content) in the service
 * worker. A first visit does not wait for all of them: installing keeps only
 * the page itself, these are kept as they are fetched, and once the page asks,
 * after it has started, the rest are fetched one at a time, so that all of the
 * app works offline.
 */

export const APP_FILES_CACHE = 'drive-app-files';

type ManifestEntry = string | { url: string };
type FileCache = Pick<Cache, 'keys' | 'delete' | 'put'>;

const entryUrl = (entry: ManifestEntry) => (typeof entry === 'string' ? entry : entry.url);

export function isAppFile(entry: ManifestEntry): boolean {
  return entryUrl(entry).startsWith('assets/');
}

/** The full addresses of the app's files in a precache manifest. */
export function appFileUrls(manifest: readonly ManifestEntry[], scope: string): Set<string> {
  return new Set(manifest.filter(isAppFile).map(entry => new URL(entryUrl(entry), scope).href));
}

/** Removes the files of earlier versions of the app. */
export async function dropOldAppFiles(cache: FileCache, appFiles: Set<string>): Promise<void> {
  for (const request of await cache.keys()) {
    if (!appFiles.has(request.url)) await cache.delete(request);
  }
}

/** Fetches the app's files not kept yet, one at a time, so that the page's own requests go first. */
export async function keepAppFiles(
  cache: FileCache,
  appFiles: Set<string>,
  fetchFile: (url: string) => Promise<Response> = url => fetch(url, { priority: 'low' }),
): Promise<void> {
  const kept = new Set((await cache.keys()).map(request => request.url));
  for (const url of appFiles) {
    if (kept.has(url)) continue;
    const response = await fetchFile(url).catch(() => null);
    // Offline: the next start tries again.
    if (!response) return;
    if (response.ok) await cache.put(url, response);
  }
}
