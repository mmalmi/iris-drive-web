import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerSWMock = vi.fn(() => vi.fn());

vi.mock('virtual:pwa-register', () => ({
  registerSW: registerSWMock,
}));

type WindowLike = {
  location: {
    protocol: string;
    hostname: string;
    origin?: string;
    search: string;
    reload?: ReturnType<typeof vi.fn>;
  };
  __HTREE_SERVER_URL__?: string;
  htree?: {
    htreeBaseUrl?: string;
  };
};

function installWindow(
  protocol: string,
  hostname: string,
  serverUrl?: string,
  search = '',
  origin?: string,
): void {
  const storage = new Map<string, string>();
  const windowLike: WindowLike = {
    location: { protocol, hostname, origin, search, reload: vi.fn() },
  };
  if (serverUrl) {
    windowLike.__HTREE_SERVER_URL__ = serverUrl;
  }

  vi.stubGlobal('window', windowLike);
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'test-client-id',
  });
}

function installServiceWorker(): void {
  const controller = {
    postMessage: vi.fn(),
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      controller,
      ready: Promise.resolve({ active: controller }),
      getRegistrations: vi.fn(async () => []),
      addEventListener: vi.fn(),
    },
  });
  vi.stubGlobal('self', { crossOriginIsolated: false });
}

function installServiceWorkerWithoutController(): void {
  const active = {
    postMessage: vi.fn(),
  };
  vi.stubGlobal('navigator', {
    serviceWorker: {
      controller: null,
      ready: Promise.resolve({ active }),
      getRegistrations: vi.fn(async () => []),
      addEventListener: vi.fn(),
    },
  });
  vi.stubGlobal('self', { crossOriginIsolated: false });
}

describe('native htree policy', () => {
  beforeEach(() => {
    vi.resetModules();
    registerSWMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps same-origin /htree routes on https pages even when Iris injects a local daemon URL', async () => {
    installWindow('https:', 'drive.iris.to', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.getInjectedHtreeServerUrl()).toBe('http://127.0.0.1:21417');
    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(false);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(true);
    expect(mediaUrl.getHtreePrefix()).toBe('');

    const videoUrl = mediaUrl.getNpubFileUrl('npub1example', 'videos/Test Clip', 'video.mp4');
    expect(videoUrl.startsWith('/htree/npub1example/videos%2FTest%20Clip/video.mp4')).toBe(true);
  });

  it('still uses the injected daemon URL on native http pages', async () => {
    installWindow('http:', '127.0.0.1', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(true);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(false);
    expect(mediaUrl.getHtreePrefix()).toBe('http://127.0.0.1:21417');
  });

  it('reads the embedded daemon URL from query params when child-webview globals are unavailable', async () => {
    installWindow('http:', '127.0.0.1', undefined, '?htree_server=http%3A%2F%2F127.0.0.1%3A21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.getInjectedHtreeServerUrl()).toBe('http://127.0.0.1:21417');
    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(true);
    expect(mediaUrl.getHtreePrefix()).toBe('http://127.0.0.1:21417');
  });

  it('uses the injected daemon URL on loopback child-webview pages with canonical htree identity', async () => {
    installWindow(
      'http:',
      'tree-example.htree.localhost',
      undefined,
      '?htree_server=http%3A%2F%2F127.0.0.1%3A21417&htree_canonical=htree%3A%2F%2Fnpub1example%2Fdrive%2Findex.html'
    );

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.getInjectedHtreeServerUrl()).toBe('http://127.0.0.1:21417');
    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(true);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(false);
    expect(nativeHtree.shouldEagerLoadMediaInNativeChildRuntime()).toBe(true);
    expect(mediaUrl.getHtreePrefix()).toBe('http://127.0.0.1:21417');
  });

  it('keeps lazy media loading on regular https pages', async () => {
    installWindow('https:', 'drive.iris.to', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');

    expect(nativeHtree.shouldEagerLoadMediaInNativeChildRuntime()).toBe(false);
  });

  it('keeps same-origin /htree routes on htree pages inside Iris', async () => {
    installWindow('htree:', 'npub1example', 'http://127.0.0.1:21417');

    const nativeHtree = await import('../src/lib/nativeHtree');
    const mediaUrl = await import('../src/lib/mediaUrl');

    expect(nativeHtree.getInjectedHtreeServerUrl()).toBe('http://127.0.0.1:21417');
    expect(nativeHtree.canUseInjectedHtreeServerUrl()).toBe(false);
    expect(nativeHtree.shouldPreferSameOriginHtreeRoutes()).toBe(true);
    expect(mediaUrl.getHtreePrefix()).toBe('');

    const videoUrl = mediaUrl.getNpubFileUrl('npub1example', 'videos/Test Clip', 'video.mp4');
    expect(videoUrl.startsWith('/htree/npub1example/videos%2FTest%20Clip/video.mp4')).toBe(true);
  });

  it('registers the service worker on https pages instead of skipping it', async () => {
    installWindow('https:', 'drive.iris.to', 'http://127.0.0.1:21417');
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).toHaveBeenCalledTimes(1);
  });

  it('skips the service worker only when the injected daemon URL is safe to use directly', async () => {
    installWindow('http:', '127.0.0.1', 'http://127.0.0.1:21417');
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).not.toHaveBeenCalled();
  });

  it('skips the service worker on local Iris gateway app pages', async () => {
    installWindow(
      'http:',
      'drive.npub1example.iris.localhost',
      undefined,
      '',
      'http://drive.npub1example.iris.localhost:17321',
    );
    installServiceWorker();

    const mediaUrl = await import('../src/lib/mediaUrl');
    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(mediaUrl.getHtreePrefix()).toBe('http://drive.npub1example.iris.localhost:17321');
    expect(registerSWMock).not.toHaveBeenCalled();
  });

  it('skips the service worker on loopback child-webview pages that preserve htree identity', async () => {
    installWindow(
      'http:',
      'tree-example.htree.localhost',
      undefined,
      '?htree_server=http%3A%2F%2F127.0.0.1%3A21417&htree_canonical=htree%3A%2F%2Fnpub1example%2Fdrive%2Findex.html'
    );
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).not.toHaveBeenCalled();
  });

  it('does not try to reload for service-worker control on loopback child-webview pages', async () => {
    installWindow(
      'http:',
      'tree-example.htree.localhost',
      undefined,
      '?htree_server=http%3A%2F%2F127.0.0.1%3A21417&htree_canonical=htree%3A%2F%2Fnpub1example%2Fdrive%2Findex.html'
    );
    installServiceWorkerWithoutController();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).not.toHaveBeenCalled();
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('does not try to register a service worker on htree child pages even when the API exists', async () => {
    installWindow('htree:', 'npub1example', 'http://127.0.0.1:21417');
    installServiceWorker();

    const { initServiceWorker } = await import('../src/lib/swInit');
    await initServiceWorker();

    expect(registerSWMock).not.toHaveBeenCalled();
  });
});
