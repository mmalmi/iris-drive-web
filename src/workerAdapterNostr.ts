import type { RuntimePublishResult, RuntimeQueryOptions, RuntimeQueryResult, NostrFilter as PubsubFilter } from 'nostr-pubsub';
import {
  generateRequestId,
  type WorkerNostrFilter as NostrFilter,
  type WorkerSignedEvent as SignedEvent,
  type WorkerPeerStats as PeerStats,
  type WorkerRelayStats as RelayStats,
  type WorkerBlossomServerConfig as BlossomServerConfig,
} from '@hashtree/core';
import type { TreeRootInfo } from '@hashtree/worker/relay-client';
import { WorkerAdapterStorage } from './workerAdapterStorage';
import type {
  EoseCallback,
  ExtendedWorkerRequest,
  SubscriptionCallback,
} from './workerAdapterCore';
import { verifyEvent } from 'nostr-tools';

/** Reject worker-cache records whose signatures were intentionally omitted. */
export function isValidSignedNostrEvent(event: SignedEvent): boolean {
  if (
    !/^[0-9a-f]{64}$/u.test(event.id)
    || !/^[0-9a-f]{64}$/u.test(event.pubkey)
    || !/^[0-9a-f]{128}$/u.test(event.sig)
  ) {
    return false;
  }
  try {
    // Verify a fresh value so a caller cannot carry nostr-tools' internal
    // verification symbol across a later mutation of `sig` or event content.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      sig: event.sig,
      kind: event.kind,
      content: event.content,
      tags: event.tags,
      created_at: event.created_at,
    });
  } catch {
    return false;
  }
}

export class WorkerAdapterNostr extends WorkerAdapterStorage {
  // Public API - Nostr
  // ============================================================================

  /**
   * Set global event callback - called for ALL events from ALL subscriptions.
   * Available for application event observers.
   */
  onEvent(callback: (event: SignedEvent) => void): void {
    this.globalEventCallback = callback;
  }

  /**
   * Subscribe to events matching filters.
   * If using global onEvent callback, no per-subscription callback needed.
   */
  subscribe(
    filters: NostrFilter[],
    callback?: SubscriptionCallback,
    eose?: EoseCallback
  ): string {
    const subId = generateRequestId();
    this.subscriptions.set(subId, { filters: structuredClone(filters), callback, eose });
    this.postMessage({ type: 'subscribe', id: subId, filters });
    return subId;
  }

  unsubscribe(subId: string): void {
    this.subscriptions.delete(subId);
    this.postMessage({ type: 'unsubscribe', id: generateRequestId(), subId });
  }

  async queryEvents(filters: PubsubFilter[], options: RuntimeQueryOptions = {}): Promise<RuntimeQueryResult> {
    const { signal, ...wireOptions } = options;
    if (signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
    const id = generateRequestId();
    const cancel = () => this.postMessage({ type: 'cancelNostrQuery', requestId: id });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.request<{ result?: RuntimeQueryResult; error?: string }>({
        type: 'query', id, filters, options: wireOptions,
      });
      if (signal?.aborted) throw new DOMException('Query cancelled', 'AbortError');
      if (response.error || !response.result) throw new Error(response.error ?? 'Missing query result');
      return response.result;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  async publish(event: SignedEvent): Promise<RuntimePublishResult | undefined> {
    if (!isValidSignedNostrEvent(event)) throw new Error('Worker publication requires a valid signed Nostr event');
    const id = generateRequestId();
    const response = await this.request<{ error?: string; receipt?: RuntimePublishResult }>({
      type: 'publish',
      id,
      event,
    });
    if (response.error) throw new Error(response.error);
    return response.receipt;
  }

  // ============================================================================
  // Public API - Stats
  // ============================================================================

  async getPeerStats(): Promise<PeerStats[]> {
    const id = generateRequestId();
    const response = await this.request<{ stats: PeerStats[] }>({
      type: 'getPeerStats',
      id,
    });
    return response.stats;
  }

  async getRelayStats(): Promise<RelayStats[]> {
    const id = generateRequestId();
    const response = await this.request<{ stats: RelayStats[] }>({
      type: 'getRelayStats',
      id,
    });
    return response.stats;
  }

  async getStorageStats(): Promise<{ items: number; bytes: number }> {
    const id = generateRequestId();
    const response = await this.request<{ items: number; bytes: number }>({
      type: 'getStorageStats',
      id,
    });
    return { items: response.items, bytes: response.bytes };
  }

  /**
   * Block a peer by pubkey (disconnect and prevent reconnection)
   */
  async blockPeer(pubkey: string): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'blockPeer',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
  }

  /**
   * Update blossom server configuration in the worker.
   * Call this when blossom settings change to sync with the worker.
   */
  async setBlossomServers(servers: BlossomServerConfig[]): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'setBlossomServers',
      id,
      servers,
    } as ExtendedWorkerRequest);
  }

  /**
   * Set storage limit for IndexedDB eviction.
   * When storage exceeds this limit, oldest entries will be evicted.
   */
  async setStorageMaxBytes(maxBytes: number): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'setStorageMaxBytes',
      id,
      maxBytes,
    } as ExtendedWorkerRequest);
  }

  /**
   * Update relay URLs dynamically.
   * Disconnects old relays and connects to new ones.
   */
  async setRelays(relays: string[]): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'setRelays',
      id,
      relays,
    } as ExtendedWorkerRequest);
  }

  /**
   * Update tree root cache in the worker.
   * Called when TreeRootRegistry updates to keep worker cache in sync.
   */
  async setTreeRootCache(
    npub: string,
    treeName: string,
    hash: Uint8Array,
    key?: Uint8Array,
    visibility: 'public' | 'link-visible' | 'private' = 'public',
    labels?: string[],
    metadata?: {
      encryptedKey?: string;
      keyId?: string;
      selfEncryptedKey?: string;
      selfEncryptedLinkKey?: string;
    }
  ): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'setTreeRootCache',
      id,
      npub,
      treeName,
      hash,
      key,
      visibility,
      labels,
      encryptedKey: metadata?.encryptedKey,
      keyId: metadata?.keyId,
      selfEncryptedKey: metadata?.selfEncryptedKey,
      selfEncryptedLinkKey: metadata?.selfEncryptedLinkKey,
    } as ExtendedWorkerRequest);
  }

  async getTreeRootInfo(npub: string, treeName: string): Promise<TreeRootInfo | null> {
    const id = generateRequestId();
    const response = await this.request<{ record?: TreeRootInfo; error?: string }>({
      type: 'getTreeRootInfo',
      id,
      npub,
      treeName,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.record ?? null;
  }

  async mergeTreeRootKey(npub: string, treeName: string, hash: Uint8Array, key: Uint8Array): Promise<boolean> {
    const id = generateRequestId();
    const response = await this.request<{ value?: boolean; error?: string }>({
      type: 'mergeTreeRootKey',
      id,
      npub,
      treeName,
      hash,
      key,
    } as ExtendedWorkerRequest);
    if (response.error) throw new Error(response.error);
    return response.value ?? false;
  }

  async subscribeTreeRoots(pubkey: string): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'subscribeTreeRoots',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
  }

  async unsubscribeTreeRoots(pubkey: string): Promise<void> {
    const id = generateRequestId();
    await this.request<{ error?: string }>({
      type: 'unsubscribeTreeRoots',
      id,
      pubkey,
    } as ExtendedWorkerRequest);
  }

  // ============================================================================
}
