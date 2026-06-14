import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverList = vi.fn();

type MockNostrState = {
  npub: string | null;
  connectedRelays: number;
};

let nostrState: MockNostrState = {
  npub: 'npub1self',
  connectedRelays: 0,
};

const nostrSubscribers = new Set<(state: MockNostrState) => void>();

const nostrStore = {
  subscribe(callback: (state: MockNostrState) => void) {
    nostrSubscribers.add(callback);
    callback(nostrState);
    return () => {
      nostrSubscribers.delete(callback);
    };
  },
  getState() {
    return nostrState;
  },
  __setState(next: Partial<MockNostrState>) {
    nostrState = { ...nostrState, ...next };
    for (const callback of Array.from(nostrSubscribers)) {
      callback(nostrState);
    }
  },
};

vi.mock('dexie', () => {
  class DexieMock {
    linkKeys = {
      toArray: vi.fn().mockResolvedValue([]),
      put: vi.fn().mockResolvedValue(undefined),
    };

    constructor(_name: string) {}

    version(_version: number) {
      return {
        stores: (_schema: Record<string, string>) => this,
      };
    }
  }

  return {
    default: DexieMock,
  };
});

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({
    list: resolverList,
  }),
}));

vi.mock('../src/nostr', () => ({
  nostrStore,
}));

describe('createTreesStore relay reconnect refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    resolverList.mockReset();
    nostrSubscribers.clear();
    nostrState = {
      npub: 'npub1self',
      connectedRelays: 0,
    };
  });

  it('refreshes the resolver list when relays reconnect even if stale entries already exist', async () => {
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    resolverList.mockImplementation((_npub: string, callback: (entries: unknown[]) => void) => {
      callback([{
        key: 'npub1owner/hashtree',
        cid: { hash: new Uint8Array(32) },
        labels: ['git'],
        visibility: 'public',
        createdAt: 100,
      }]);
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      return unsubscribe;
    });

    const { createTreesStore } = await import('../src/stores/trees');
    const store = createTreesStore('npub1owner');
    const stop = store.subscribe(() => {});

    expect(resolverList).toHaveBeenCalledTimes(1);

    nostrStore.__setState({ connectedRelays: 1 });
    await Promise.resolve();

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(resolverList).toHaveBeenCalledTimes(2);

    stop();
  });
});
