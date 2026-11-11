/**
 * WorkerStore - Store implementation that proxies to the hashtree worker
 *
 * This implements the Store interface, allowing HashTree to use worker-based
 * storage without knowing about the worker details.
 */

import type { Store, Hash } from '@hashtree/core';
import { getWorkerAdapter, waitForWorkerAdapter } from '../lib/workerInit';

/** How long a read or write waits for a worker that is still starting. */
const WORKER_START_WAIT_MS = 30_000;

/**
 * Store implementation that proxies all operations to the hashtree worker.
 * Operations that arrive while the worker is still starting wait for it: a
 * write dropped at that point would leave a tree pointing at data that was
 * never stored.
 */
export class WorkerStore implements Store {
  constructor(private readonly startWaitMs = WORKER_START_WAIT_MS) {}

  private async adapter() {
    return getWorkerAdapter() ?? await waitForWorkerAdapter(this.startWaitMs);
  }

  async put(hash: Hash, data: Uint8Array): Promise<boolean> {
    const adapter = await this.adapter();
    if (!adapter) throw new Error('Storage is not available');
    return adapter.put(hash, data);
  }

  async get(hash: Hash): Promise<Uint8Array | null> {
    const adapter = await this.adapter();
    if (!adapter) {
      console.warn('[WorkerStore] Worker not ready, get failed');
      return null;
    }
    return adapter.get(hash);
  }

  async has(hash: Hash): Promise<boolean> {
    const adapter = await this.adapter();
    if (!adapter) {
      return false;
    }
    return adapter.has(hash);
  }

  async delete(hash: Hash): Promise<boolean> {
    const adapter = await this.adapter();
    if (!adapter) {
      return false;
    }
    return adapter.delete(hash);
  }
}

// Singleton instance
let instance: WorkerStore | null = null;

export function getWorkerStore(): WorkerStore {
  if (!instance) {
    instance = new WorkerStore();
  }
  return instance;
}
