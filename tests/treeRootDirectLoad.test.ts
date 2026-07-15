// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { toHex } from '@hashtree/core';

const shared = vi.hoisted(() => {
  type MockNostrState = {
    connectedRelays: number;
    pubkey: string | null;
    npub: string | null;
  };

  let nostrState: MockNostrState = {
    connectedRelays: 1,
    pubkey: 'owner-pubkey',
    npub: 'npub1owner',
  };

  const nostrSubscribers = new Set<(state: MockNostrState) => void>();
  const resolverCallbacks = new Map<string, (resolvedCid?: { hash: Uint8Array; key?: Uint8Array } | null, visibilityInfo?: {
    visibility?: 'public' | 'link-visible' | 'private';
    encryptedKey?: string;
    keyId?: string;
    selfEncryptedKey?: string;
    selfEncryptedLinkKey?: string;
  }, metadata?: { updatedAt?: number }) => void>();
  const resolverSubscribe = vi.fn((key: string, callback: (resolvedCid?: { hash: Uint8Array; key?: Uint8Array } | null, visibilityInfo?: {
    visibility?: 'public' | 'link-visible' | 'private';
    encryptedKey?: string;
    keyId?: string;
    selfEncryptedKey?: string;
    selfEncryptedLinkKey?: string;
  }, metadata?: { updatedAt?: number }) => void) => {
    resolverCallbacks.set(key, callback);
    return () => {
      resolverCallbacks.delete(key);
    };
  });
  const resolverList = vi.fn(() => () => {});
  const resolverPublish = vi.fn(async () => true);
  const syncNativeTreeRootCache = vi.fn(async () => {});

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

  return {
    nostrStore,
    resolverCallbacks,
    resolverList,
    resolverPublish,
    resolverSubscribe,
    syncNativeTreeRootCache,
  };
});

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({
    subscribe: shared.resolverSubscribe,
    list: shared.resolverList,
    publish: shared.resolverPublish,
  }),
  getResolverKey: (npub?: string, treeName?: string) => (npub && treeName ? `${npub}/${treeName}` : null),
}));

vi.mock('../src/nostr', () => ({
  nostrStore: shared.nostrStore,
  decrypt: vi.fn(async () => ''),
}));

vi.mock('../src/nostr/trees', () => ({
  npubToPubkey: (npub: string) => npub,
}));

vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: () => null,
  isWorkerReady: () => true,
  waitForWorkerAdapter: async () => null,
}));

vi.mock('../src/lib/nativeTreeRootCache', () => ({
  syncNativeTreeRootCache: shared.syncNativeTreeRootCache,
}));

vi.mock('../src/lib/htreeDebug', () => ({
  logHtreeDebug: vi.fn(),
}));

describe('tree root direct load', () => {
  beforeEach(() => {
    vi.resetModules();
    shared.resolverCallbacks.clear();
    shared.resolverSubscribe.mockClear();
    shared.resolverList.mockClear();
    shared.resolverPublish.mockClear();
    shared.syncNativeTreeRootCache.mockClear();
    window.localStorage?.clear?.();
    window.location.hash = '#/npub1owner/boards%2Firis?k=' + '11'.repeat(32);
    delete (globalThis as Record<string, unknown>).__treeRootStoreInitialized;
  });

  it('recovers a direct link-visible load when the resolver supplies the content key', async () => {
    const { treeRootStore } = await import('../src/stores/treeRoot');

    await new Promise(resolve => setTimeout(resolve, 25));

    const resolverKey = 'npub1owner/boards/iris';
    const callback = shared.resolverCallbacks.get(resolverKey);
    expect(shared.resolverSubscribe).toHaveBeenCalled();
    expect(callback).toBeTypeOf('function');

    const hash = new Uint8Array(32);
    hash[0] = 7;
    const contentKey = new Uint8Array(32);
    contentKey[0] = 9;

    callback?.(
      { hash, key: contentKey },
      {
        visibility: 'link-visible',
        encryptedKey: 'aa'.repeat(32),
      },
      {
        updatedAt: 123,
      }
    );

    await new Promise(resolve => setTimeout(resolve, 25));

    const root = get(treeRootStore);
    expect(root).not.toBeNull();
    expect(toHex(root!.hash)).toBe(toHex(hash));
    expect(toHex(root!.key!)).toBe(toHex(contentKey));
  }, 15_000);
});
