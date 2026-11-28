import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools';

const mocks = vi.hoisted(() => ({ query: vi.fn(), cached: vi.fn(), relays: ['wss://relay.example'] }));
const cached = { id: 'cached-only', content: 'wrapped' } as Event;
vi.mock('../src/nostr', () => ({
  nostr: { subscribe: mocks.cached },
}));
vi.mock('../src/nostr/client', () => ({ getNostrRelayUrls: () => mocks.relays }));
vi.mock('../src/workerAdapter', () => ({ getWorkerAdapter: () => ({ queryEvents: mocks.query }) }));

import { whenRelaysHold } from '../src/lib/relayHolds';

describe('confirming recovery records on relays', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', undefined);
    mocks.relays = ['wss://relay.example'];
    mocks.query.mockReset().mockResolvedValue({ events: [] });
    mocks.cached.mockReset().mockImplementation(() => ({
      on: (name: string, handler: (event: Event) => void) => {
        if (name === 'event') queueMicrotask(() => handler(cached));
      },
      stop: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not mistake local cached or echoed records for relay storage', async () => {
    const held = vi.fn();
    const filter = { authors: ['recovery-key'] };
    const stop = whenRelaysHold(filter, () => true, held);
    await vi.advanceTimersByTimeAsync(0);
    expect(held).not.toHaveBeenCalled();
    expect(mocks.cached).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith([filter], expect.objectContaining({
      cache: 'network-only', localEcho: false, relays: ['wss://relay.example'], sources: [],
    }));
    stop();
  });

  it('confirms once when a relay returns a record with the required wrapping', async () => {
    const held = vi.fn();
    mocks.query.mockResolvedValueOnce({ events: [{ ...cached, content: 'old wrapping' }] })
      .mockResolvedValue({ events: [cached] });
    whenRelaysHold({ authors: ['recovery-key'] }, event => event.content === 'wrapped', held);
    await vi.advanceTimersByTimeAsync(0);
    expect(held).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(held).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('cancels an outstanding read when the page leaves and ignores its late result', async () => {
    let resolve!: (value: { events: Event[] }) => void;
    mocks.query.mockReturnValue(new Promise(value => { resolve = value; }));
    const held = vi.fn();
    const stop = whenRelaysHold({}, () => true, held);
    const signal = mocks.query.mock.calls[0][1].signal as AbortSignal;
    stop();
    expect(signal.aborted).toBe(true);
    resolve({ events: [cached] });
    await vi.advanceTimersByTimeAsync(0);
    expect(held).not.toHaveBeenCalled();
  });

  it('does not overlap slow reads or confirm while no relay is configured', async () => {
    const held = vi.fn();
    mocks.relays = [];
    const stop = whenRelaysHold({}, () => true, held);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.relays = ['wss://relay.example'];
    mocks.query.mockReturnValue(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(held).not.toHaveBeenCalled();
    stop();
  });
});
