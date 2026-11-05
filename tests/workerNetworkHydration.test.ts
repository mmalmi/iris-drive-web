import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  get: vi.fn(), put: vi.fn(), initWorker: vi.fn(), initNative: vi.fn(), endpoints: vi.fn(),
}));

vi.mock('dexie', () => ({
  default: class {
    settings = { get: state.get, put: state.put };
    version() { return { stores: () => { this.settings = { get: state.get, put: state.put }; return this; } }; }
  },
}));
vi.mock('../src/workerAdapter', () => ({
  initWorkerAdapter: state.initWorker, getWorkerAdapter: () => null, setWorkerAdapterInstance: vi.fn(),
}));
vi.mock('../src/nativeAdapter', () => ({ initNativeBackend: state.initNative }));
vi.mock('../src/store', () => ({ refreshFipsStats: vi.fn(), setBlossomBandwidth: vi.fn() }));
vi.mock('../src/utils/socialGraph', () => ({ setupVersionCallback: vi.fn() }));
vi.mock('../src/nostr/client', () => ({ nostr: { setBackend: vi.fn() } }));
vi.mock('../src/nostr/relays', () => ({ initRelayTracking: vi.fn() }));
vi.mock('../src/appType', () => ({ getAppType: () => 'files' }));
vi.mock('../src/lib/htreeDebug', () => ({ logHtreeDebug: vi.fn() }));
vi.mock('../src/lib/htreeRuntime', () => ({
  getRuntimeEndpoints: state.endpoints, getRuntimeHtreeServerUrl: () => null,
}));
vi.mock('../src/lib/runtimeNetwork', () => ({
  getEffectiveNostrRelays: (relays: string[]) => relays,
  getEffectiveBlossomServers: (servers: unknown[]) => servers,
}));
vi.mock('../src/lib/workerTreeRootBridge', () => ({ setupTreeRootRegistryBridge: vi.fn() }));
vi.mock('../src/treeRootCache', () => ({ initializePublishFn: vi.fn(async () => undefined) }));
vi.mock('../src/lib/mediaStreamingSetup', () => ({ setupMediaStreaming: vi.fn(async () => undefined) }));
vi.mock('../src/lib/driveFipsRuntime', () => ({
  attachDriveFipsProvider: vi.fn(), startDriveFipsRuntime: vi.fn(), stopDriveFipsRuntime: vi.fn(),
}));
vi.mock('../src/lib/driveFipsIdentity', () => ({
  createDriveFipsRosterAuthorizationSource: vi.fn(), resolveDriveFipsIdentity: () => null,
}));
vi.mock('../src/accounts', () => ({ accountsStore: { getState: () => ({ accounts: [] }) } }));
vi.mock('../src/workers/hashtree.worker?worker', () => ({ default: class {} }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('VITE_TEST_MODE', '');
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('window', {
    location: { protocol: 'https:', hostname: 'drive.example', origin: 'https://drive.example', search: '' },
  });
  state.get.mockReset().mockResolvedValue(undefined);
  state.put.mockReset().mockResolvedValue(undefined);
  state.initWorker.mockReset().mockResolvedValue(null);
  state.initNative.mockReset().mockResolvedValue(null);
  state.endpoints.mockReset().mockImplementation(({ relays, blossomServers }) => ({
    nostrRelays: relays, blossomServers,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('worker networking waits for saved settings', () => {
  test('does not start default networking while custom settings take longer than 500ms', async () => {
    const saved = { relays: ['wss://relay.example'], blossomServers: [], negentropyEnabled: false };
    let release!: (row: unknown) => void;
    const persisted = new Promise(resolve => { release = resolve; });
    state.get.mockImplementation(async key => key === 'network' ? persisted : undefined);
    const { initHashtreeBackend } = await import('../src/lib/workerInit');
    const boot = initHashtreeBackend({ pubkey: '11'.repeat(32) });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(state.endpoints).not.toHaveBeenCalled();
      expect(state.initWorker).not.toHaveBeenCalled();
      expect(state.initNative).not.toHaveBeenCalled();
    } finally {
      release({ key: 'network', value: saved });
      await boot;
    }
    expect(state.endpoints).toHaveBeenCalledWith({ relays: saved.relays, blossomServers: [] });
    expect(state.initWorker).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
      relays: saved.relays, blossomServers: [],
    }));
  });

  test('does not start networking when saved settings cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.get.mockImplementation(async key => {
      if (key === 'network') throw new Error('saved settings unavailable');
      return undefined;
    });
    const { initHashtreeBackend } = await import('../src/lib/workerInit');
    await initHashtreeBackend({ pubkey: '11'.repeat(32) });
    expect(state.endpoints).not.toHaveBeenCalled();
    expect(state.initWorker).not.toHaveBeenCalled();
    expect(state.initNative).not.toHaveBeenCalled();
  });
});
