import { describe, expect, test, vi } from 'vitest';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { WorkerAdapter } from '../src/workerAdapter';
import {
  isValidSignedNostrEvent,
} from '../src/workerAdapterNostr';

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
  test('keeps partial history distinct from completion while later signed events remain live', async () => {
    const { adapter, worker } = await initializedAdapter();
    const history = vi.fn();
    const acceptedEvents: Array<{ id: string }> = [];
    const subId = adapter.subscribe([{ kinds: [7368] }], event => {
      if (isValidSignedNostrEvent(event)) acceptedEvents.push(event);
    }, history);
    const signed = finalizeEvent({ kind: 7368, created_at: 1_787_000_000, tags: [], content: '' }, generateSecretKey());
    worker.emit({ type: 'event', subId, event: { ...signed, sig: '' } });
    worker.emit({ type: 'nostrStatus', subId, status: { complete: false, reason: 'timeout' } });
    expect(acceptedEvents).toEqual([]);
    expect(history).toHaveBeenCalledWith({ complete: false, reason: 'timeout' });
    worker.emit({ type: 'event', subId, event: signed });
    expect(acceptedEvents).toEqual([signed]);
    adapter.unsubscribe(subId); adapter.close();
  });

  test('cancels remote history work and reports worker query failures', async () => {
    const { adapter, worker } = await initializedAdapter();
    const controller = new AbortController();
    const pending = adapter.queryEvents([{ kinds: [1] }], { signal: controller.signal });
    const request = worker.posted.at(-1)!.message;
    controller.abort();
    expect(worker.posted.at(-1)!.message).toMatchObject({ type: 'cancelNostrQuery', requestId: request.id });
    worker.emit({ type: 'nostrQuery', id: request.id, error: 'Nostr operation cancelled' });
    await expect(pending).rejects.toThrow('Query cancelled');
    const failed = adapter.queryEvents([{ kinds: [1] }]);
    worker.emit({ type: 'nostrQuery', id: worker.posted.at(-1)!.message.id, error: 'Index unavailable' });
    await expect(failed).rejects.toThrow('Index unavailable');
    adapter.close();
  });

  test('forwards the complete signed Nostr event to the relay-facing worker unchanged', async () => {
    const { adapter, worker } = await initializedAdapter();
    const event = finalizeEvent({
      kind: 7368,
      created_at: 1_787_000_000,
      tags: [['i', '89f3d04f-41fb-437b-9339-75df537bf291']],
      content: '{"schema":1}',
    }, generateSecretKey());

    const publishing = adapter.publish(event);
    const request = worker.posted.find(({ message }) => message.type === 'publish')?.message;
    expect(request?.event).toEqual(event);
    expect((request?.event as typeof event).sig).toBe(event.sig);
    worker.emit({ type: 'void', id: request?.id });
    await expect(publishing).resolves.toBeUndefined();
    adapter.close();
  });

  test('does not send an event without a valid signature to the relay-facing worker', async () => {
    const { adapter, worker } = await initializedAdapter();
    const event = finalizeEvent({
      kind: 7368,
      created_at: 1_787_000_000,
      tags: [],
      content: '',
    }, generateSecretKey());
    const postedBefore = worker.posted.length;

    const publishing = adapter.publish({ ...event, sig: '' });
    const request = worker.posted.slice(postedBefore)
      .find(({ message }) => message.type === 'publish')?.message;
    if (request) worker.emit({ type: 'void', id: request.id });

    await expect(publishing).rejects.toThrow('valid signed Nostr event');
    expect(request).toBeUndefined();
    adapter.close();
  });

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

  test('queues provider state while a replacement worker is starting', async () => {
    vi.useFakeTimers();
    try {
      const { adapter, worker } = await initializedAdapter();
      worker.onerror?.({} as ErrorEvent);
      await vi.advanceTimersByTimeAsync(1_000);

      const replacement = FakeWorker.latest;
      expect(replacement).not.toBe(worker);
      expect(replacement?.posted[0]?.message).toMatchObject({
        type: 'init',
        p2pProviderEnabled: false,
      });

      adapter.setP2PProvider({ fetch: async () => null, listPeerIds: () => [] });
      replacement?.emit({ type: 'ready' });
      expect(replacement?.posted.at(-1)?.message).toMatchObject({
        type: 'setP2PProviderState',
        enabled: true,
      });
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

  test('reports successful identity changes to runtime integrations', async () => {
    const { adapter, worker } = await initializedAdapter();
    const changes: Array<{ pubkey: string; nsec?: string }> = [];
    adapter.onIdentityChange((identity) => changes.push(identity));

    const update = adapter.setIdentity('22'.repeat(32), '33'.repeat(32));
    const request = worker.posted.at(-1)?.message;
    worker.emit({ type: 'void', id: request?.id });
    await update;

    expect(changes).toEqual([{ pubkey: '22'.repeat(32), nsec: '33'.repeat(32) }]);
    adapter.close();
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
