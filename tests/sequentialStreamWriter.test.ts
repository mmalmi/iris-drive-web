import { describe, expect, it, vi } from 'vitest';
import { createSequentialStreamWriter } from '../src/lib/sequentialStreamWriter';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe('createSequentialStreamWriter', () => {
  it('serializes writes and closes only after queued chunks flush', async () => {
    const firstWrite = deferred();
    const secondWrite = deferred();
    const calls: string[] = [];
    const writer = {
      write: vi.fn()
        .mockImplementationOnce(async () => {
          calls.push('write:first');
          await firstWrite.promise;
        })
        .mockImplementationOnce(async () => {
          calls.push('write:second');
          await secondWrite.promise;
        }),
      close: vi.fn(async () => {
        calls.push('close');
      }),
      abort: vi.fn(async () => {
        calls.push('abort');
      }),
    };
    const onClosed = vi.fn();
    const stream = createSequentialStreamWriter({ writer, onClosed });

    stream.enqueue(new Uint8Array([1]));
    stream.enqueue(new Uint8Array([2]));
    stream.close();

    await Promise.resolve();
    expect(calls).toEqual(['write:first']);
    expect(writer.close).not.toHaveBeenCalled();

    firstWrite.resolve();
    await flushPromises();
    expect(calls).toEqual(['write:first', 'write:second']);

    secondWrite.resolve();
    await flushPromises();
    expect(calls).toEqual(['write:first', 'write:second', 'close']);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(writer.abort).not.toHaveBeenCalled();
  });

  it('aborts on inactivity instead of leaving the stream open forever', () => {
    vi.useFakeTimers();
    try {
      const writer = {
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
      };
      const onTimeout = vi.fn();
      const onClosed = vi.fn();
      const stream = createSequentialStreamWriter({
        writer,
        inactivityTimeoutMs: 1000,
        onTimeout,
        onClosed,
      });

      stream.enqueue(new Uint8Array([1]));
      vi.advanceTimersByTime(1000);

      expect(onTimeout).toHaveBeenCalledTimes(1);
      expect(writer.abort).toHaveBeenCalledTimes(1);
      stream.enqueue(new Uint8Array([2]));
      expect(writer.write).toHaveBeenCalledTimes(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts when a queued write fails', async () => {
    const error = new Error('consumer closed');
    const writer = {
      write: vi.fn(async () => {
        throw error;
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const onError = vi.fn();
    const stream = createSequentialStreamWriter({ writer, onError });

    stream.enqueue(new Uint8Array([1]));
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(error);
    expect(writer.abort).toHaveBeenCalledWith(error);
    expect(writer.close).not.toHaveBeenCalled();
  });
});
