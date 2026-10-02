// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeRootRecord } from '../src/TreeRootRegistry';
import type { ExtendedWorkerRequest } from '../src/workerAdapterCore';

const state = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: () => state.adapter,
  waitForWorkerAdapter: async () => state.adapter,
  isWorkerReady: () => true,
}));
vi.mock('../src/nostr', () => ({ nostrStore: { getState: () => ({}), subscribe: () => () => {} } }));
vi.mock('../src/nostr/trees', () => ({ npubToPubkey: (value: string) => value }));

function record(updatedAt: number, source: TreeRootRecord['source'] = 'nostr'): TreeRootRecord {
  return { hash: new Uint8Array(32).fill(1), key: new Uint8Array(32).fill(2),
    updatedAt, source, visibility: 'public', dirty: source === 'local-write' };
}

async function adapter() {
  const { WorkerAdapter } = await import('../src/workerAdapter');
  class RecordingAdapter extends WorkerAdapter {
    readonly messages: ExtendedWorkerRequest[] = [];
    protected override async request<T>(message: ExtendedWorkerRequest): Promise<T> {
      this.messages.push(message);
      return {} as T;
    }
  }
  const result = new RecordingAdapter('test-worker', { relays: [] });
  state.adapter = result;
  return result;
}

beforeEach(() => {
  vi.resetModules();
  window.localStorage?.clear?.();
  delete window.__treeRootRegistry;
});
afterEach(async () => {
  const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
  setupTreeRootRegistryBridge(() => null);
  const { treeRootRegistry } = await import('../src/TreeRootRegistry');
  for (const key of treeRootRegistry.getAllRecords().keys()) {
    const slash = key.indexOf('/');
    treeRootRegistry.cancelPendingPublish(key.slice(0, slash), key.slice(slash + 1));
    treeRootRegistry.delete(key.slice(0, slash), key.slice(slash + 1));
  }
  state.adapter = null;
});

describe('worker root provenance', () => {
  it('preserves the remote event timestamp through the actual resolver bridge and adapter', async () => {
    const target = await adapter();
    const { syncResolvedTreeRootToWorker } = await import('../src/stores/treeRootWorker');
    await syncResolvedTreeRootToWorker('npub1owner/public', record(100));
    expect(target.messages).toEqual([expect.objectContaining({ type: 'setTreeRootCache',
      npub: 'npub1owner', treeName: 'public', source: 'remote', updatedAt: 100 })]);
  });

  it('forwards a newer event timestamp even when the encrypted root is unchanged', async () => {
    const target = await adapter();
    const { syncResolvedTreeRootToWorker } = await import('../src/stores/treeRootWorker');
    await syncResolvedTreeRootToWorker('npub1owner/public', record(100));
    await syncResolvedTreeRootToWorker('npub1owner/public', record(200));
    expect(target.messages).toHaveLength(2);
    expect(target.messages[1]).toMatchObject({ source: 'remote', updatedAt: 200 });
  });

  it('keeps local writes authoritative with their original logical timestamp', async () => {
    const target = await adapter();
    const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
    const { treeRootRegistry } = await import('../src/TreeRootRegistry');
    setupTreeRootRegistryBridge(() => target);
    const root = record(100, 'local-write');
    treeRootRegistry.setLocal('npub1owner', 'public', root.hash, { key: root.key });
    expect(target.messages).toEqual([expect.objectContaining({ source: 'local-write',
      updatedAt: treeRootRegistry.get('npub1owner', 'public')!.updatedAt })]);
  });

  it('rehydrates persisted remote roots without granting local-write authority', async () => {
    const target = await adapter();
    const { treeRootRegistry } = await import('../src/TreeRootRegistry');
    for (const source of ['nostr', 'worker', 'prefetch'] as const) {
      treeRootRegistry.setFromExternal('npub1owner', source, record(100).hash, source, { updatedAt: 100 });
    }
    const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
    setupTreeRootRegistryBridge(() => target);
    expect(target.messages).toHaveLength(3);
    for (const message of target.messages) expect(message).toMatchObject({ source: 'remote', updatedAt: 100 });
  });

  it('treats an already-published local root as remote history on bootstrap', async () => {
    const target = await adapter();
    const { treeRootRegistry } = await import('../src/TreeRootRegistry');
    treeRootRegistry.setFromExternal('npub1owner', 'public', record(100).hash, 'local-write', { updatedAt: 100 });
    expect(treeRootRegistry.get('npub1owner', 'public')?.dirty).toBe(false);
    const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
    setupTreeRootRegistryBridge(() => target);
    expect(target.messages).toEqual([expect.objectContaining({ source: 'remote', updatedAt: 100 })]);
  });

  it('preserves unsent local-write authority on bootstrap', async () => {
    const target = await adapter();
    const { treeRootRegistry } = await import('../src/TreeRootRegistry');
    treeRootRegistry.setLocal('npub1owner', 'public', record(100).hash);
    const root = treeRootRegistry.get('npub1owner', 'public')!;
    expect(root.dirty).toBe(true);
    const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
    setupTreeRootRegistryBridge(() => target);
    expect(target.messages).toEqual([expect.objectContaining({ source: 'local-write', updatedAt: root.updatedAt })]);
  });

  it('does not echo worker-origin notifications back into the worker', async () => {
    const target = await adapter();
    const { treeRootRegistry } = await import('../src/TreeRootRegistry');
    const { setupTreeRootRegistryBridge } = await import('../src/lib/workerTreeRootBridge');
    const { syncResolvedTreeRootToWorker } = await import('../src/stores/treeRootWorker');
    setupTreeRootRegistryBridge(() => target);
    const root = record(100, 'worker');
    treeRootRegistry.setFromWorker('npub1owner', 'public', root.hash, 100);
    await syncResolvedTreeRootToWorker('npub1owner/public', root);
    expect(target.messages).toEqual([]);
  });

  it('preserves the legacy unannotated local-write request contract', async () => {
    const target = await adapter();
    await target.setTreeRootCache('npub1owner', 'public', record(100).hash);
    expect(target.messages).toEqual([expect.objectContaining({ type: 'setTreeRootCache', visibility: 'public' })]);
    expect(target.messages[0]).not.toHaveProperty('source', 'remote');
    expect(target.messages[0]).not.toHaveProperty('updatedAt', 100);
  });
});
