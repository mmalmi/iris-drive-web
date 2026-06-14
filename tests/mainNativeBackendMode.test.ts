import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mount = vi.fn();
const initServiceWorker = vi.fn();
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
    vi.doMock('../src/lib/swInit', () => ({ initServiceWorker }));
    vi.doMock('../src/nostr/auth', () => ({ initReadonlyBackend, restoreSession }));
    vi.doMock('../src/appType', () => ({ setAppType }));
    vi.doMock('../src/lib/htreeApi', () => ({ initHtreeApi }));
    vi.doMock('../src/lib/workerInit', () => ({ waitForRelayConnection }));
    vi.doMock('../src/App.svelte', () => ({ default: {} }));

    await import('../src/main');

    expect(initReadonlyBackend).toHaveBeenCalledOnce();
    expect(restoreSession).toHaveBeenCalledOnce();
    expect(waitForRelayConnection).toHaveBeenCalledOnce();
  });
});
