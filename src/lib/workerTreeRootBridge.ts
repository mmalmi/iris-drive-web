import type { BackendAdapter } from '../workerAdapter';
import { treeRootRegistry } from '../TreeRootRegistry';

// Track tree root registry subscription and worker update listener
let treeRootRegistryUnsubscribe: (() => void) | null = null;
let workerTreeRootUnsubscribe: (() => void) | null = null;

/**
 * Set up bidirectional sync between tree root registry and worker.
 * - Local writes (main->worker): For worker to publish to Nostr
 * - Worker updates (worker->main): Nostr subscription results
 */
export function setupTreeRootRegistryBridge(getWorkerAdapter: () => BackendAdapter | null): void {
  // Clean up previous subscriptions
  if (treeRootRegistryUnsubscribe) {
    treeRootRegistryUnsubscribe();
    treeRootRegistryUnsubscribe = null;
  }
  if (workerTreeRootUnsubscribe) {
    workerTreeRootUnsubscribe();
    workerTreeRootUnsubscribe = null;
  }

  const adapter = getWorkerAdapter();
  if (!adapter) return;

  // 1. Sync local writes from main thread to worker (for publishing)
  if ('setTreeRootCache' in adapter) {
    treeRootRegistryUnsubscribe = treeRootRegistry.subscribeAll(async (key, record) => {
      // Only sync local writes - worker handles its own Nostr updates
      if (!record || record.source !== 'local-write') return;

      const slashIndex = key.indexOf('/');
      if (slashIndex <= 0) return;

      const npub = key.slice(0, slashIndex);
      const treeName = key.slice(slashIndex + 1);

      try {
        await (adapter as {
          setTreeRootCache: (
            npub: string,
            treeName: string,
            hash: Uint8Array,
            key?: Uint8Array,
            visibility?: 'public' | 'link-visible' | 'private',
            labels?: string[],
            metadata?: {
              source?: 'local-write' | 'remote';
              updatedAt?: number;
              encryptedKey?: string;
              keyId?: string;
              selfEncryptedKey?: string;
              selfEncryptedLinkKey?: string;
            }
          ) => Promise<void>;
        }).setTreeRootCache(npub, treeName, record.hash, record.key, record.visibility, record.labels, {
          source: 'local-write',
          updatedAt: record.updatedAt,
          encryptedKey: record.encryptedKey,
          keyId: record.keyId,
          selfEncryptedKey: record.selfEncryptedKey,
          selfEncryptedLinkKey: record.selfEncryptedLinkKey,
        });
      } catch (err) {
        console.warn('[WorkerInit] Failed to sync local write to worker:', err);
      }
    });

    // Sync existing persisted entries to worker.
    // This primes worker /htree fetches on reload even when the latest
    // cached source is "worker"/"nostr" (not only "local-write").
    for (const [key, record] of treeRootRegistry.getAllRecords()) {
      const slashIndex = key.indexOf('/');
      if (slashIndex <= 0) continue;

      const npub = key.slice(0, slashIndex);
      const treeName = key.slice(slashIndex + 1);

      (adapter as {
        setTreeRootCache: (
          npub: string,
          treeName: string,
          hash: Uint8Array,
          key?: Uint8Array,
          visibility?: 'public' | 'link-visible' | 'private',
          labels?: string[],
          metadata?: {
            source?: 'local-write' | 'remote';
            updatedAt?: number;
            encryptedKey?: string;
            keyId?: string;
            selfEncryptedKey?: string;
            selfEncryptedLinkKey?: string;
          }
        ) => Promise<void>;
      })
        .setTreeRootCache(npub, treeName, record.hash, record.key, record.visibility, record.labels, {
          source: record.source === 'local-write' && record.dirty ? 'local-write' : 'remote',
          updatedAt: record.updatedAt,
          encryptedKey: record.encryptedKey,
          keyId: record.keyId,
          selfEncryptedKey: record.selfEncryptedKey,
          selfEncryptedLinkKey: record.selfEncryptedLinkKey,
        })
        .catch(err => console.warn('[WorkerInit] Failed to sync initial local write to worker:', err));
    }
  }

  // 2. Listen for worker tree root updates (from Nostr subscriptions)
  if ('onTreeRootUpdate' in adapter) {
    workerTreeRootUnsubscribe = (adapter as { onTreeRootUpdate: (cb: (npub: string, treeName: string, hash: Uint8Array, updatedAt: number, options: { key?: Uint8Array; visibility: string; labels?: string[]; encryptedKey?: string; keyId?: string; selfEncryptedKey?: string; selfEncryptedLinkKey?: string }) => void) => () => void })
      .onTreeRootUpdate((npub, treeName, hash, updatedAt, options) => {
        treeRootRegistry.setFromWorker(npub, treeName, hash, updatedAt, {
          key: options.key,
          visibility: options.visibility as 'public' | 'link-visible' | 'private',
          labels: options.labels,
          encryptedKey: options.encryptedKey,
          keyId: options.keyId,
          selfEncryptedKey: options.selfEncryptedKey,
          selfEncryptedLinkKey: options.selfEncryptedLinkKey,
        });
      });
  }

  console.log('[WorkerInit] Tree root registry bridge set up (bidirectional)');
}
