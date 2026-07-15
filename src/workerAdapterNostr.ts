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

export class WorkerAdapterNostr extends WorkerAdapterStorage {
  // Public API - Nostr
  // ============================================================================

  /**
   * Set global event callback - called for ALL events from ALL subscriptions.
   * Used with ndk.subManager.dispatchEvent pattern.
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
    this.subscriptions.set(subId, { callback, eose });
    this.postMessage({ type: 'subscribe', id: subId, filters });
    return subId;
  }

  unsubscribe(subId: string): void {
    this.subscriptions.delete(subId);
    this.postMessage({ type: 'unsubscribe', id: generateRequestId(), subId });
  }

  async publish(event: SignedEvent): Promise<void> {
    const id = generateRequestId();
    const response = await this.request<{ error?: string }>({
      type: 'publish',
      id,
      event,
    });
    if (response.error) throw new Error(response.error);
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
