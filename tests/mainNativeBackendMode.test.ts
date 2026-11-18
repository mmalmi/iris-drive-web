import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mount = vi.fn();
const initServiceWorker = vi.fn();
const keepAppForOffline = vi.fn();
const initReadonlyBackend = vi.fn();
const restoreSession = vi.fn();
const initHtreeApi = vi.fn();
const waitForRelayConnection = vi.fn();
const setAppType = vi.fn();

describe('main native backend bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    mount.mockReset();
    initServiceWorker.mockReset();
    keepAppForOffline.mockReset();
    initReadonlyBackend.mockReset();
    restoreSession.mockReset();
    initHtreeApi.mockReset();
    waitForRelayConnection.mockReset();
    setAppType.mockReset();

    vi.stubGlobal('document', {
      getElementById: vi.fn(() => ({ id: 'app' })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('boots the backend runtime instead of the old readonly worker path', async () => {
    initServiceWorker.mockResolvedValue(undefined);
    initReadonlyBackend.mockResolvedValue(undefined);
    restoreSession.mockResolvedValue(undefined);
    initHtreeApi.mockResolvedValue(undefined);
    waitForRelayConnection.mockResolvedValue(true);

    vi.doMock('svelte', () => ({ mount }));
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker, keepAppForOffline }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/workerInit', () => ({ waitForRelayConnection }));
    vi.doMock('../src/App.svelte', () => ({ default: {} }));

    await import('../src/main');

    expect(initReadonlyBackend).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(waitForRelayConnection).toHaveBeenCalledOnce());
  });

  it('mounts the UI while backend network settings are still loading', async () => {
    let release!: () => void;
    initServiceWorker.mockResolvedValue(undefined);
    initReadonlyBackend.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    restoreSession.mockResolvedValue(undefined);
    initHtreeApi.mockResolvedValue(undefined);
    waitForRelayConnection.mockResolvedValue(true);

    vi.doMock('svelte', () => ({ mount }));
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker, keepAppForOffline }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/workerInit', () => ({ waitForRelayConnection }));
    vi.doMock('../src/App.svelte', () => ({ default: {} }));

    await import('../src/main');
    try {
      expect(mount).toHaveBeenCalledOnce();
      expect(initReadonlyBackend).toHaveBeenCalledOnce();
      expect(waitForRelayConnection).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await vi.waitFor(() => expect(waitForRelayConnection).toHaveBeenCalledOnce());
  });

  it('waits for a restored signer before choosing an anonymous graph identity', async () => {
    let finishRestore!: (restored: boolean) => void;
    restoreSession.mockReturnValue(new Promise<boolean>(resolve => { finishRestore = resolve; }));
    initServiceWorker.mockResolvedValue(undefined);
    initHtreeApi.mockResolvedValue(undefined);
    waitForRelayConnection.mockResolvedValue(true);

    vi.doMock('svelte', () => ({ mount }));
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker, keepAppForOffline }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/workerInit', () => ({ waitForRelayConnection }));
    vi.doMock('../src/App.svelte', () => ({ default: {} }));

    await import('../src/main');
    expect(mount).toHaveBeenCalledOnce();
    expect(initReadonlyBackend).not.toHaveBeenCalled();
    finishRestore(true);
    await vi.waitFor(() => expect(waitForRelayConnection).toHaveBeenCalledOnce());
    expect(initReadonlyBackend).not.toHaveBeenCalled();
  });

  it('starts the account and backend while the service worker is still installing', async () => {
    let installed!: () => void;
    initServiceWorker.mockImplementation(() => new Promise<void>(resolve => { installed = resolve; }));
    initReadonlyBackend.mockResolvedValue(undefined);
    restoreSession.mockResolvedValue(undefined);
    initHtreeApi.mockResolvedValue(undefined);
    waitForRelayConnection.mockResolvedValue(true);

    vi.doMock('svelte', () => ({ mount }));
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker, keepAppForOffline }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/workerInit', () => ({ waitForRelayConnection }));
    vi.doMock('../src/App.svelte', () => ({ default: {} }));

    await import('../src/main');
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(initReadonlyBackend).toHaveBeenCalledOnce();
    expect(keepAppForOffline).not.toHaveBeenCalled();
    installed();
    // The rest of the app is kept for offline use only once the service worker is there.
    await vi.waitFor(() => expect(keepAppForOffline).toHaveBeenCalledOnce());
  });
});
