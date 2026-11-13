// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackoffPoll } from '../src/lib/backoffPoll';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('backoff poll', () => {
  it('runs less often while nothing changes, sooner when kicked, and not while hidden', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const poll = startBackoffPoll(task, { minMs: 1_000, maxMs: 8_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 8_000);
    expect(task).toHaveBeenCalledTimes(5);

    poll.kick();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(6);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(6);
    setHidden(false);
    expect(task).toHaveBeenCalledTimes(7);

    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(7);
  });
});
