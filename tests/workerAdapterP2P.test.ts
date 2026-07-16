import { describe, expect, test, vi } from 'vitest';
import { WorkerAdapter } from '../src/workerAdapter';

type PostedMessage = {
  message: Record<string, unknown>;
  transfer?: Transferable[];
};

class FakeWorker {
  static latest: FakeWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: PostedMessage[] = [];

  constructor() {
    FakeWorker.latest = this;
  }

  postMessage(message: Record<string, unknown>, transfer?: Transferable[]): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {}

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

async function initializedAdapter(): Promise<{ adapter: WorkerAdapter; worker: FakeWorker }> {
  const adapter = new WorkerAdapter(FakeWorker as unknown as new () => Worker, {
    relays: ['wss://relay.example'],
    pubkey: '11'.repeat(32),
  });
  const init = adapter.init();
  const worker = FakeWorker.latest;
  if (!worker) throw new Error('fake worker was not constructed');
  worker.emit({ type: 'ready' });
  await init;
  return { adapter, worker };
}

describe('WorkerAdapter external P2P bridge', () => {
  test('keeps worker provider state aligned across install and removal', async () => {
    const { adapter, worker } = await initializedAdapter();
    expect(worker.posted[0]?.message.p2pProviderEnabled).toBe(false);

    adapter.setP2PProvider({ fetch: async () => null, listPeerIds: () => [] });
    expect(worker.posted.at(-1)?.message).toMatchObject({
      type: 'setP2PProviderState',
      enabled: true,
    });

    adapter.setP2PProvider(null);
    expect(worker.posted.at(-1)?.message).toMatchObject({
      type: 'setP2PProviderState',
      enabled: false,
    });
    adapter.close();
  });

  test('restores provider state when a crashed worker is replaced', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, worker } = await initializedAdapter();
      adapter.setP2PProvider({ fetch: async () => null, listPeerIds: () => [] });

      worker.onerror?.({} as ErrorEvent);
      await vi.advanceTimersByTimeAsync(1_000);

      const replacement = FakeWorker.latest;
      expect(replacement).not.toBe(worker);
      expect(replacement?.posted[0]?.message).toMatchObject({
        type: 'init',
        p2pProviderEnabled: true,
      });
      replacement?.emit({ type: 'ready' });
      adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('retries an idempotent identity update after worker replacement', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, worker } = await initializedAdapter();
      const update = adapter.setIdentity('22'.repeat(32), '33'.repeat(32));
      expect(worker.posted.at(-1)?.message.type).toBe('setIdentity');

      worker.onerror?.({} as ErrorEvent);
      await vi.advanceTimersByTimeAsync(1_000);

      const replacement = FakeWorker.latest;
      replacement?.emit({ type: 'ready' });
      const request = replacement?.posted.find(({ message }) => message.type === 'setIdentity');
      expect(request?.message).toMatchObject({
        type: 'setIdentity',
        pubkey: '22'.repeat(32),
        nsec: '33'.repeat(32),
      });
      replacement?.emit({ type: 'void', id: request?.message.id });
      await expect(update).resolves.toBeUndefined();
      adapter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns provider bytes to a worker P2P request', async () => {
    const { adapter, worker } = await initializedAdapter();
    const fetch = vi.fn(async () => new Uint8Array([1, 2, 3]));
    adapter.setP2PProvider({ fetch, listPeerIds: () => ['peer-a'] });

    worker.emit({
      type: 'p2pFetch',
      requestId: 'fetch-1',
      hashHex: 'ab'.repeat(32),
      htl: 10,
      peerId: 'peer-a',
    });
    await vi.waitFor(() => {
      expect(worker.posted.some(({ message }) => (
        message.type === 'p2pFetchResult' && message.requestId === 'fetch-1'
      ))).toBe(true);
    });

    expect(fetch).toHaveBeenCalledWith('ab'.repeat(32), 'peer-a', 10);
    const response = worker.posted.find(({ message }) => message.type === 'p2pFetchResult');
    expect(Array.from(response?.message.data as Uint8Array)).toEqual([1, 2, 3]);
    expect(response?.transfer).toHaveLength(1);
    adapter.close();
  });

  test('returns an error when a worker fetch has no configured route', async () => {
    const { adapter, worker } = await initializedAdapter();

    worker.emit({
      type: 'p2pFetch',
      requestId: 'fetch-without-route',
      hashHex: 'cd'.repeat(32),
      htl: 10,
    });
    await vi.waitFor(() => {
      expect(worker.posted.some(({ message }) => (
        message.type === 'p2pFetchResult' && message.requestId === 'fetch-without-route'
      ))).toBe(true);
    });

    expect(worker.posted.find(({ message }) => (
      message.type === 'p2pFetchResult' && message.requestId === 'fetch-without-route'
    ))?.message).toMatchObject({
      error: 'No P2P blob route configured',
    });
    adapter.close();
  });

  test('returns the provider peer list without starting the legacy proxy', async () => {
    const { adapter, worker } = await initializedAdapter();
    adapter.setP2PProvider({ fetch: async () => null, listPeerIds: async () => ['peer-b', 'peer-a'] });

    worker.emit({ type: 'p2pPeerList', requestId: 'peers-1' });
    await vi.waitFor(() => {
      expect(worker.posted.some(({ message }) => (
        message.type === 'p2pPeerListResult' && message.requestId === 'peers-1'
      ))).toBe(true);
    });

    const response = worker.posted.find(({ message }) => message.type === 'p2pPeerListResult');
    expect(response?.message.peerIds).toEqual(['peer-b', 'peer-a']);
    expect(worker.posted.some(({ message }) => String(message.type).startsWith('rtc:'))).toBe(false);
    adapter.close();
  });
});
