import { afterEach, describe, expect, it, vi } from 'vitest';

function installWindow(
  serverUrl?: string,
  search = '',
  location: {
    protocol?: string;
    hostname?: string;
    origin?: string;
  } = {},
): void {
  vi.stubGlobal('window', {
    location: {
      protocol: location.protocol ?? 'htree:',
      hostname: location.hostname ?? 'npub1example',
      origin: location.origin ?? 'htree://npub1example',
      search,
    },
    __HTREE_SERVER_URL__: serverUrl,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('runtime blossom server selection', () => {
  it('prepends the embedded daemon blossom endpoint and keeps upstream fallbacks', async () => {
    installWindow('http://127.0.0.1:21417');
    const { getEffectiveBlossomServers } = await import('../src/lib/runtimeNetwork');

    expect(getEffectiveBlossomServers([
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://cdn.iris.to', read: true, write: false },
    ])).toEqual([
      { url: 'http://127.0.0.1:21417', read: true, write: true },
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://cdn.iris.to', read: true, write: false },
    ]);
  });

  it('deduplicates a manually configured daemon blossom endpoint', async () => {
    installWindow(undefined, '?htree_server=http%3A%2F%2F127.0.0.1%3A21417');
    const { getEffectiveBlossomServers } = await import('../src/lib/runtimeNetwork');

    expect(getEffectiveBlossomServers([
      { url: 'http://127.0.0.1:21417/', read: true, write: false },
      { url: 'https://upload.iris.to', read: false, write: true },
    ])).toEqual([
      { url: 'http://127.0.0.1:21417', read: true, write: true },
      { url: 'https://upload.iris.to', read: false, write: true },
    ]);
  });

  it('uses the Iris Drive same-origin gateway as the runtime endpoint on iris.localhost apps', async () => {
    installWindow(undefined, '', {
      protocol: 'http:',
      hostname: 'video.npub1example.iris.localhost',
      origin: 'http://video.npub1example.iris.localhost:17321',
    });
    const { getEffectiveBlossomServers, getEffectiveNostrRelays } = await import('../src/lib/runtimeNetwork');

    expect(getEffectiveBlossomServers([
      { url: 'https://upload.iris.to', read: false, write: true },
    ])).toEqual([
      { url: 'http://video.npub1example.iris.localhost:17321', read: true, write: true },
      { url: 'https://upload.iris.to', read: false, write: true },
    ]);
    expect(getEffectiveNostrRelays(['wss://relay.example'])).toEqual([
      'ws://video.npub1example.iris.localhost:17321/ws',
    ]);
  });
});
