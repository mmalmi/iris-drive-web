import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function installWindow(protocol: string, hostname: string): void {
  vi.stubGlobal('window', {
    location: { protocol, hostname },
  });
}

function mockNativeHtree(canUse: boolean, serverUrl: string | null): void {
  vi.doMock('../src/lib/nativeHtree', () => ({
    canUseInjectedHtreeServerUrl: () => canUse,
    getInjectedHtreeServerUrl: () => serverUrl,
  }));
}

describe('native share actions', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts share actions to the injected local Rust endpoint', async () => {
    installWindow('http:', '127.0.0.1');
    mockNativeHtree(true, 'http://127.0.0.1:17321/');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      shares: [],
      share_id: '123e4567-e89b-42d3-a456-426614174000',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { dispatchNativeShareAction, nativeShareActionEndpoint } = await import('../src/drive/nativeShareActions');

    expect(nativeShareActionEndpoint()).toBe('http://127.0.0.1:17321/api/iris-drive/share-action');
    const result = await dispatchNativeShareAction({
      type: 'create_share',
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
    });

    expect(result.share_id).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17321/api/iris-drive/share-action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'create_share',
          source_path: 'Projects/Alpha',
          display_name: 'Alpha',
        }),
      }),
    );
  });

  it('loads current shares from the local Rust endpoint', async () => {
    installWindow('http:', '127.0.0.1');
    mockNativeHtree(true, 'http://127.0.0.1:17321/');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      shares: [{
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        display_name: 'Alpha',
        source_path: 'Projects/Alpha',
        shared_with_me_path: 'Shared with me/Alpha',
        local_role: 'reader',
        current_app_pubkey: 'a'.repeat(64),
        key_status: 'available',
        write_authorization: 'authorized',
        can_write: false,
        can_admin: false,
        has_current_key_wrap: true,
        key_unavailable: false,
        repair_needed: false,
        missing_key_wrap_count: 0,
        missing_key_wrap_pubkeys: [],
        participant_count: 2,
        app_key_count: 2,
        members: [],
        shortcut_paths: [],
      }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { fetchNativeShareState } = await import('../src/drive/nativeShareActions');
    const result = await fetchNativeShareState();

    expect(result.shares[0]?.display_name).toBe('Alpha');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:17321/api/iris-drive/share-action',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the same-origin route on local Iris gateway pages', async () => {
    installWindow('http:', 'main.drive.iris.localhost');
    mockNativeHtree(false, null);

    const { nativeShareActionEndpoint } = await import('../src/drive/nativeShareActions');

    expect(nativeShareActionEndpoint()).toBe('/api/iris-drive/share-action');
  });

  it('does not expose share mutations on regular https pages', async () => {
    installWindow('https:', 'drive.iris.to');
    mockNativeHtree(false, 'http://127.0.0.1:17321');

    const { canUseNativeShareActions, nativeShareActionEndpoint } = await import('../src/drive/nativeShareActions');

    expect(nativeShareActionEndpoint()).toBeNull();
    expect(canUseNativeShareActions()).toBe(false);
  });
});
