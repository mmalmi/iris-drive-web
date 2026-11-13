// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setVisibleInterval } from '../src/lib/visibleInterval';

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

describe('visible interval', () => {
  it('pauses while hidden and catches up once when shown', async () => {
    vi.useFakeTimers();
    const task = vi.fn();
    const stop = setVisibleInterval(task, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task).toHaveBeenCalledTimes(3);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(3);
    setHidden(false);
    expect(task).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(5);
  });
});
