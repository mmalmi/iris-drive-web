import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromHex } from '@hashtree/core';

type WindowLike = {
  location: {
    protocol: string;
    hostname: string;
    search: string;
  };
  __HTREE_SERVER_URL__?: string;
};

function installWindow(serverUrl?: string, search = ''): void {
  const windowLike: WindowLike = {
    location: {
      protocol: 'http:',
      hostname: '127.0.0.1',
      search,
    },
  };

  if (serverUrl) {
    windowLike.__HTREE_SERVER_URL__ = serverUrl;
  }

  vi.stubGlobal('window', windowLike);
}

describe('native tree root cache sync', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts known tree roots to the injected daemon cache once per unique root', async () => {
    installWindow('http://127.0.0.1:21417');
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const {
      resetNativeTreeRootCacheSyncState,
      syncNativeTreeRootCache,
    } = await import('../src/lib/nativeTreeRootCache');

    resetNativeTreeRootCacheSyncState();

    const cid = {
      hash: fromHex('a'.repeat(64)),
      key: fromHex('b'.repeat(64)),
    };

    await syncNativeTreeRootCache('npub1example', 'videos/Test Clip', cid, 'public');
    await syncNativeTreeRootCache('npub1example', 'videos/Test Clip', cid, 'public');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:21417/api/cache-tree-root',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          npub: 'npub1example',
          treeName: 'videos/Test Clip',
          hash: 'a'.repeat(64),
          key: 'b'.repeat(64),
          visibility: 'public',
        }),
      }),
    );
  });

  it('skips sync when Iris has not injected a daemon url', async () => {
    installWindow(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const {
      resetNativeTreeRootCacheSyncState,
      syncNativeTreeRootCache,
    } = await import('../src/lib/nativeTreeRootCache');

    resetNativeTreeRootCacheSyncState();

    await syncNativeTreeRootCache(
      'npub1example',
      'videos/Test Clip',
      { hash: fromHex('c'.repeat(64)) },
      'public',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
