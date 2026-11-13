// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  upstreamStart: vi.fn(),
  upstreamStop: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('nostr-social-graph/publicGraphSync', () => ({
  startGraphSync: (options: unknown) => {
    shared.upstreamStart(options);
    return shared.upstreamStop;
  },
  syncGraphLists: vi.fn(),
}));

vi.mock('../src/workerAdapter', () => ({
  getWorkerAdapter: () => ({ refreshSocialGraph: shared.refresh }),
}));

import { requestGraphSync, startGraphSync } from '../src/workers/graphSyncOnDemand';
import {
  refreshSocialGraph,
  resetSocialGraphRefresh,
  startBackgroundSocialGraphRefresh,
} from '../src/lib/socialGraphRefresh';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  resetSocialGraphRefresh();
});

describe('follow-list catch-up in the worker', () => {
  it('runs one pass at start, none on its own after that, and one per request', () => {
    const getGraph = vi.fn();
    const stop = startGraphSync({ getGraph, relays: ['wss://relay.example'] } as never);
    expect(shared.upstreamStart).toHaveBeenCalledTimes(1);
    // The library's next pass would be a day away: in practice the next request.
    expect(shared.upstreamStart.mock.calls[0][0]).toMatchObject({ getGraph, intervalMs: 24 * 60 * 60 * 1000 });

    // A request replaces the pass that may still run.
    expect(requestGraphSync()).toBe(true);
    expect(shared.upstreamStop).toHaveBeenCalledTimes(1);
    expect(shared.upstreamStart).toHaveBeenCalledTimes(2);

    stop();
    expect(shared.upstreamStop).toHaveBeenCalledTimes(2);
    expect(requestGraphSync()).toBe(false);
    expect(shared.upstreamStart).toHaveBeenCalledTimes(2);
  });
});

describe('asking for fresh follow lists', () => {
  it('asks when people search opens, but not again within five minutes', () => {
    expect(refreshSocialGraph(1_000_000)).toBe(true);
    expect(refreshSocialGraph(1_000_000 + 4 * 60_000)).toBe(false);
    expect(refreshSocialGraph(1_000_000 + 5 * 60_000)).toBe(true);
    expect(shared.refresh).toHaveBeenCalledTimes(2);
  });

  it('otherwise asks every 30 minutes while the page is shown, not at start', async () => {
    vi.useFakeTimers();
    const stop = startBackgroundSocialGraphRefresh();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(shared.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(shared.refresh).toHaveBeenCalledTimes(1);

    // A search in between moves the next background pass back.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refreshSocialGraph()).toBe(true);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(shared.refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(shared.refresh).toHaveBeenCalledTimes(3);
    stop();
  });
});
