import { afterEach, describe, expect, it, vi } from 'vitest';

function installWindow(protocol: string, hostname: string, search = ''): void {
  vi.stubGlobal('window', {
    location: {
      protocol,
      hostname,
      search,
    },
    __HTREE_SERVER_URL__: 'http://127.0.0.1:21417',
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native htree routing policy', () => {
  it('allows direct loopback daemon URLs for htree protocol pages', async () => {
    installWindow('htree:', 'nhash1example');
    const { canUseInjectedHtreeServerUrl, shouldPreferSameOriginHtreeRoutes } = await import('../src/lib/nativeHtree');
    expect(shouldPreferSameOriginHtreeRoutes()).toBe(false);
    expect(canUseInjectedHtreeServerUrl()).toBe(true);
  });

  it('keeps same-origin routes for https pages to avoid mixed content', async () => {
    installWindow('https:', 'drive.iris.to');
    const { canUseInjectedHtreeServerUrl, shouldPreferSameOriginHtreeRoutes } = await import('../src/lib/nativeHtree');
    expect(shouldPreferSameOriginHtreeRoutes()).toBe(true);
    expect(canUseInjectedHtreeServerUrl()).toBe(false);
  });
});
