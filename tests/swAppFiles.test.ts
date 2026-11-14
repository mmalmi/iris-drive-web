import { describe, expect, it } from 'vitest';
import { appFileUrls, dropOldAppFiles, isAppFile, keepAppFiles } from '../src/lib/swAppFiles';

const scope = 'https://drive.example/';

function fakeCache(urls: string[] = []) {
  const kept = new Map(urls.map(url => [url, new Response('old')]));
  const urlOf = (request: RequestInfo | URL) => (typeof request === 'string' ? request : (request as Request).url);
  return {
    kept,
    keys: async () => [...kept.keys()].map(url => new Request(url)),
    delete: async (request: RequestInfo | URL) => kept.delete(urlOf(request)),
    put: async (request: RequestInfo | URL, response: Response) => {
      kept.set(urlOf(request), response);
    },
  } as unknown as Cache & { kept: Map<string, Response> };
}

describe('the app files the service worker keeps', () => {
  it('are the content-named files of the manifest, not the page and its icons', () => {
    const manifest = [
      { url: 'index.html', revision: 'a' },
      { url: 'iris-drive-icon.svg', revision: 'b' },
      { url: 'assets/index-AbC123.js', revision: null },
      'assets/sheet-Xy9.css',
    ];
    expect(manifest.filter(entry => !isAppFile(entry))).toEqual(manifest.slice(0, 2));
    expect([...appFileUrls(manifest, scope)]).toEqual([
      'https://drive.example/assets/index-AbC123.js',
      'https://drive.example/assets/sheet-Xy9.css',
    ]);
  });

  it('fetches only those not kept yet, one at a time, and drops earlier versions', async () => {
    const files = appFileUrls(['assets/a.js', 'assets/b.js', 'assets/c.js'], scope);
    const cache = fakeCache([`${scope}assets/a.js`, `${scope}assets/old.js`]);
    await dropOldAppFiles(cache, files);
    expect([...cache.kept.keys()]).toEqual([`${scope}assets/a.js`]);

    const fetched: string[] = [];
    let inFlight = 0;
    await keepAppFiles(cache, files, async (url) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      fetched.push(url);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(url);
    });
    expect(fetched).toEqual([`${scope}assets/b.js`, `${scope}assets/c.js`]);
    expect([...cache.kept.keys()].sort()).toEqual([...files].sort());
  });

  it('stops when the network is gone and skips files the server does not have', async () => {
    const files = appFileUrls(['assets/a.js', 'assets/b.js', 'assets/c.js'], scope);
    const cache = fakeCache();
    await keepAppFiles(cache, files, async (url) => {
      if (url.endsWith('a.js')) return new Response('missing', { status: 404 });
      if (url.endsWith('b.js')) return new Response('b');
      throw new TypeError('offline');
    });
    expect([...cache.kept.keys()]).toEqual([`${scope}assets/b.js`]);
  });
});
