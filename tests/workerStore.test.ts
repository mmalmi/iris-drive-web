import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ adapter: null as null | Record<string, ReturnType<typeof vi.fn>> }));

vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: () => state.adapter,
  waitForWorkerAdapter: async (maxWaitMs: number) => {
    const start = Date.now();
    while (!state.adapter && Date.now() - start < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return state.adapter;
  },
}));

import { WorkerStore } from '../src/stores/workerStore';

const hash = new Uint8Array(32).fill(7);
const data = new Uint8Array([1, 2, 3]);

function startWorkerAfter(ms: number) {
  const adapter = {
    put: vi.fn(async () => true),
    get: vi.fn(async () => data),
    has: vi.fn(async () => true),
    delete: vi.fn(async () => true),
  };
  setTimeout(() => {
    state.adapter = adapter;
  }, ms);
  return adapter;
}

describe('WorkerStore while the worker is starting', () => {
  beforeEach(() => {
    state.adapter = null;
  });

  it('keeps a write until the worker is ready instead of dropping it', async () => {
    const adapter = startWorkerAfter(40);
    await expect(new WorkerStore(1000).put(hash, data)).resolves.toBe(true);
    expect(adapter.put).toHaveBeenCalledWith(hash, data);
  });

  it('reads once the worker is ready instead of reporting the data missing', async () => {
    startWorkerAfter(40);
    await expect(new WorkerStore(1000).get(hash)).resolves.toEqual(data);
  });

  it('fails a write loudly when the worker never starts', async () => {
    await expect(new WorkerStore(30).put(hash, data)).rejects.toThrow('Storage is not available');
  });

  it('reports data missing when the worker never starts', async () => {
    const store = new WorkerStore(30);
    await expect(store.get(hash)).resolves.toBeNull();
    await expect(store.has(hash)).resolves.toBe(false);
  });
});
