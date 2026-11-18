import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/settings', () => ({
  DEFAULT_NETWORK_SETTINGS: { relays: [], blossomServers: [] },
  settingsStore: { subscribe: (run: (state: { network: object }) => void) => {
    run({ network: {} });
    return () => {};
  } },
}));

const relay = 'wss://relay.example.com';
const blossom = { url: 'https://blossom.example.com', read: true, write: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Drive through the Iris Drive browser bridge', () => {
  it('uses browser storage and treats the native bridge as read-only', async () => {
    const location = new URL('http://drive.publisher.iris.localhost:17321/index.html');
    vi.stubGlobal('window', { location });
    const { getHtreeRuntime, getRuntimeEndpoints } = await import('../src/lib/htreeRuntime');

    expect(getRuntimeEndpoints({
      relays: [relay],
      blossomServers: [{ url: `${location.origin}/`, read: false, write: true }, blossom],
    })).toEqual({
      htreeServerUrl: null,
      nostrRelays: [relay],
      blossomServers: [{ url: location.origin, read: true, write: false }, blossom],
    });
    expect(getHtreeRuntime().urls.request({
      kind: 'mutable', npub: 'npub1example', treeName: 'files', path: 'notes.txt',
    })).toBe('/htree/npub1example/files/notes.txt');
  });

  it('preserves an explicitly injected writable native backend', async () => {
    const location = new URL('http://drive.publisher.iris.localhost:17321/index.html');
    const htreeServerUrl = 'http://127.0.0.1:21417';
    vi.stubGlobal('window', { location, __HTREE_SERVER_URL__: htreeServerUrl });
    const { getRuntimeEndpoints } = await import('../src/lib/htreeRuntime');

    expect(getRuntimeEndpoints({ relays: [relay], blossomServers: [blossom] })).toEqual({
      htreeServerUrl,
      nostrRelays: ['ws://127.0.0.1:21417/ws'],
      blossomServers: [{ url: htreeServerUrl, read: true, write: true }, blossom],
    });
  });
});
