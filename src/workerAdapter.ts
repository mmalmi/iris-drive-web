/**
 * Worker Adapter public entrypoint.
 * Implementation is split by API surface to keep each module small.
 */
import type {
  WorkerPeerStats as PeerStats,
  WorkerRelayStats as RelayStats,
  WorkerBlossomBandwidthStats as BlossomBandwidthStats,
  WorkerBlossomUploadProgress as BlossomUploadProgress,
} from '@hashtree/core';
import { WorkerAdapterSocial } from './workerAdapterSocial';
import type { WorkerAdapterConfig, WorkerConstructor } from './workerAdapterCore';

export class WorkerAdapter extends WorkerAdapterSocial {}

export type BackendAdapter = Omit<WorkerAdapter, 'setP2PProvider'> & {
  setP2PProvider?: WorkerAdapter['setP2PProvider'];
};

let instance: BackendAdapter | null = null;

// Expose on window for tests to reliably access (avoids Vite module duplication issues)
declare global {
  interface Window {
    __workerAdapter?: BackendAdapter | null;
  }
}

export function getWorkerAdapter(): BackendAdapter | null {
  return instance;
}

export function setWorkerAdapterInstance(adapter: BackendAdapter | null): void {
  instance = adapter;

  if (typeof window !== 'undefined') {
    window.__workerAdapter = instance;
  }
}

export async function initWorkerAdapter(
  workerFactory: WorkerConstructor,
  config: WorkerAdapterConfig
): Promise<WorkerAdapter> {
  if (instance) {
    return instance as WorkerAdapter;
  }

  instance = new WorkerAdapter(workerFactory, config);
  await (instance as WorkerAdapter).init();

  // Expose on window for tests
  if (typeof window !== 'undefined') {
    window.__workerAdapter = instance;
  }

  return instance as WorkerAdapter;
}

export function closeWorkerAdapter(): void {
  if (instance) {
    instance.setP2PProvider?.(null);
    instance.close();
    instance = null;
  }
  void import('./lib/driveFipsRuntime').then(({ stopDriveFipsRuntime }) => stopDriveFipsRuntime());
}

// Re-export types for consumers
export type { PeerStats, RelayStats };
export type {
  BlossomBandwidthStats as WorkerBlossomBandwidthStats,
  BlossomUploadProgress as WorkerBlossomUploadProgress,
};
