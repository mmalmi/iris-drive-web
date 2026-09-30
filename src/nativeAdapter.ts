import type { Filter } from 'nostr-tools';
import {
  BlossomStore,
  cid,
  toHex,
  type BlossomAuthEvent,
  type CID,
  type WorkerBlossomBandwidthStats,
  type WorkerBlossomServerConfig,
  type WorkerBlossomUploadProgress,
  type WorkerDirEntry,
  type WorkerNostrFilter,
  type WorkerPeerStats,
  type WorkerRelayStats,
  type WorkerSignedEvent,
  type WorkerSocialGraphEvent as SocialGraphEvent,
} from '@hashtree/core';
import { createNostrRuntime, type NostrRuntime, type RuntimePublishResult, type RuntimeQueryOptions } from 'nostr-pubsub';
import type { HistoryStatus } from '@iris/hashtree-app/nostr';
import type { TreeRootInfo } from '@hashtree/worker/relay-client';
import { getEffectiveNostrRelayUrls } from './nostr/client';
import { getRuntimeHtreeServerUrl } from './lib/htreeRuntime';
import { syncNativeTreeRootCache } from './lib/nativeTreeRootCache';
import { treeRootRegistry } from './TreeRootRegistry';
import { nostrStore } from './nostr/store';
import type { BackendAdapter } from './workerAdapter';
import type { WorkerInitIdentity } from './lib/workerInit';
import {
  EMPTY_BLOSSOM_BANDWIDTH,
  addBlossomServerBytes,
  assertServerUrl,
  cloneBlossomBandwidthStats,
  createNativeHtreeUrl,
  decodeNativeResolvedRoot,
  mapNativeDirEntries,
  normalizeServerUrl,
  type DirListingResponse,
  type FollowsSubscription,
  type NativeTreeRootCacheMetadata,
  type NativeTreeRootUpdateCallback,
  type RelayConfig,
  type ResolveRootResponse,
  type SubscriptionRecord,
} from './nativeAdapterHelpers';

export class NativeBackendAdapter implements BackendAdapter {
  private readonly serverUrl: string;
  private readonly runtime: NostrRuntime;
  private identity: WorkerInitIdentity;
  private relays: string[];
  private blossomServers: WorkerBlossomServerConfig[];
  private globalEventCallback: ((event: WorkerSignedEvent) => void) | null = null;
  private blossomProgressCallback: ((progress: WorkerBlossomUploadProgress) => void) | null = null;
  private blossomBandwidthCallback: ((stats: WorkerBlossomBandwidthStats) => void) | null = null;
  private blossomPushProgressCallback:
    | ((treeName: string, current: number, total: number) => void)
    | null = null;
  private blossomPushCompleteCallback:
    | ((treeName: string, pushed: number, skipped: number, failed: number) => void)
    | null = null;
  private socialGraphVersionCallback: ((version: number) => void) | null = null;
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  private readonly followsSubscriptions = new Map<string, FollowsSubscription>();
  private blossomBandwidth: WorkerBlossomBandwidthStats = EMPTY_BLOSSOM_BANDWIDTH;
  private blossomSession: WorkerBlossomUploadProgress | null = null;

  constructor(serverUrl: string, config: RelayConfig) {
    this.serverUrl = normalizeServerUrl(serverUrl);
    this.runtime = createNostrRuntime({ relays: getEffectiveNostrRelayUrls(config.relays) });
    this.identity = { pubkey: config.pubkey, nsec: config.nsec };
    this.relays = Array.isArray(config.relays) ? [...config.relays] : [];
    this.blossomServers = Array.isArray(config.blossomServers) ? [...config.blossomServers] : [];
  }

  async init(): Promise<void> {
    this.runtime.setRelays(getEffectiveNostrRelayUrls(this.relays));
  }

  onBlossomProgress(callback: (progress: WorkerBlossomUploadProgress) => void): void {
    this.blossomProgressCallback = callback;
  }

  onBlossomBandwidth(callback: (stats: WorkerBlossomBandwidthStats) => void): void {
    this.blossomBandwidthCallback = callback;
    callback(this.blossomBandwidth);
  }

  onBlossomPushProgress(callback: (treeName: string, current: number, total: number) => void): void {
    this.blossomPushProgressCallback = callback;
  }

  onBlossomPushComplete(
    callback: (treeName: string, pushed: number, skipped: number, failed: number) => void
  ): void {
    this.blossomPushCompleteCallback = callback;
  }

  onTreeRootUpdate(_callback: NativeTreeRootUpdateCallback): () => void {
    return () => {};
  }

  onEvent(callback: (event: WorkerSignedEvent) => void): void {
    this.globalEventCallback = callback;
  }

  onSocialGraphVersion(callback: (version: number) => void): void {
    this.socialGraphVersionCallback = callback;
    callback(0);
  }

  async startBlossomSession(sessionId: string, totalChunks: number): Promise<void> {
    this.blossomSession = {
      sessionId,
      totalChunks,
      processedChunks: 0,
      servers: this.blossomServers.map((server) => ({
        url: server.url,
        uploaded: 0,
        failed: 0,
        skipped: 0,
      })),
    };
    this.blossomProgressCallback?.(this.blossomSession);
  }

  async endBlossomSession(): Promise<void> {
    this.blossomSession = null;
  }

  private emitBlossomBandwidth(): void {
    const stats = cloneBlossomBandwidthStats(this.blossomBandwidth);
    this.blossomBandwidth = stats;
    this.blossomBandwidthCallback?.(stats);
  }

  private updateBlossomServerBytes(
    serverUrl: string,
    bytesSentDelta: number,
    bytesReceivedDelta: number
  ): void {
    this.blossomBandwidth = addBlossomServerBytes(
      this.blossomBandwidth,
      serverUrl,
      bytesSentDelta,
      bytesReceivedDelta
    );
    this.emitBlossomBandwidth();
  }

  private createBlossomStore(
    onUploadProgress?: (serverUrl: string, status: 'uploaded' | 'skipped' | 'failed') => void
  ): BlossomStore {
    return new BlossomStore({
      servers: this.blossomServers,
      signer: async (event) => await import('./nostr/client').then(({ signEvent }) => signEvent(event as Parameters<typeof signEvent>[0])) as BlossomAuthEvent,
      onUploadProgress,
      logger: (entry) => {
        if (entry.operation === 'put' && entry.success) {
          this.updateBlossomServerBytes(entry.server, entry.bytes ?? 0, 0);
        } else if (entry.operation === 'get' && entry.success) {
          this.updateBlossomServerBytes(entry.server, 0, entry.bytes ?? 0);
        }
      },
    });
  }

  async pushToBlossom(
    cidHash: Uint8Array,
    cidKey?: Uint8Array,
    treeName?: string
  ): Promise<{ pushed: number; skipped: number; failed: number; errors?: string[] }> {
    const { getTree } = await import('./store');
    const tree = getTree();
    const target = cid(cidHash, cidKey);
    const name = treeName ?? 'tree';
    const uploadStore = this.createBlossomStore((serverUrl, status) => {
      if (!this.blossomSession) return;
      const server = this.blossomSession.servers.find((entry) => normalizeServerUrl(entry.url) === normalizeServerUrl(serverUrl));
      if (!server) return;
      server[status] += 1;
      this.blossomProgressCallback?.(this.blossomSession);
    });

    const result = await tree.push(target, uploadStore, {
      onProgress: (current, total) => {
        if (this.blossomSession) {
          this.blossomSession.processedChunks = current;
          this.blossomSession.totalChunks = total;
          this.blossomProgressCallback?.(this.blossomSession);
        }
        this.blossomPushProgressCallback?.(name, current, total);
      },
    });

    this.blossomPushCompleteCallback?.(name, result.pushed, result.skipped, result.failed);
    return {
      pushed: result.pushed,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors.length > 0 ? result.errors.map((error) => error.error.message) : undefined,
    };
  }

  async republishTrees(prefix?: string): Promise<{ count: number; encryptionErrors?: string[] }> {
    const { getAllLocalRoots } = await import('./treeRootCache');
    const state = nostrStore.getState();
    if (!state.npub) return { count: 0 };

    let count = 0;
    const encryptionErrors: string[] = [];
    for (const [key, record] of getAllLocalRoots().entries()) {
      const slashIndex = key.indexOf('/');
      if (slashIndex <= 0) continue;
      const npub = key.slice(0, slashIndex);
      const treeName = key.slice(slashIndex + 1);
      if (npub !== state.npub) continue;
      if (prefix && !treeName.startsWith(decodeURIComponent(prefix))) continue;
      try {
        const { saveHashtree } = await import('./nostr/trees');
        const result = await saveHashtree(treeName, cid(record.hash, record.key), {
          visibility: record.visibility,
          labels: record.labels,
        });
        if (result.success) count += 1;
      } catch (error) {
        encryptionErrors.push(String(error));
      }
    }

    return {
      count,
      encryptionErrors: encryptionErrors.length > 0 ? encryptionErrors : undefined,
    };
  }

  async republishTree(pubkey: string, treeName: string): Promise<boolean> {
    const state = nostrStore.getState();
    const ownNpub = state.npub;
    const key = ownNpub ? `${ownNpub}/${treeName}` : null;
    const record = key ? treeRootRegistry.getByKey(key) : null;
    if (!ownNpub || pubkey !== state.pubkey || !record) {
      return false;
    }
    const { saveHashtree } = await import('./nostr/trees');
    const result = await saveHashtree(treeName, cid(record.hash, record.key), {
      visibility: record.visibility,
      labels: record.labels,
    });
    return result.success;
  }

  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    const response = await fetch(`${this.serverUrl}/__iris/store/${toHex(hash)}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Native blob get failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(hash: Uint8Array, data: Uint8Array): Promise<boolean> {
    const response = await fetch(`${this.serverUrl}/__iris/store/${toHex(hash)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(body || `Native blob put failed with ${response.status}`);
    }
    return response.status === 201;
  }

  async has(hash: Uint8Array): Promise<boolean> {
    const response = await fetch(`${this.serverUrl}/__iris/store/${toHex(hash)}`, {
      method: 'HEAD',
      cache: 'no-store',
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Native blob head failed with ${response.status}`);
    return true;
  }

  async delete(hash: Uint8Array): Promise<boolean> {
    const response = await fetch(`${this.serverUrl}/__iris/store/${toHex(hash)}`, {
      method: 'DELETE',
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Native blob delete failed with ${response.status}`);
    return true;
  }

  private htreeUrl(target: CID, path?: string): string {
    return createNativeHtreeUrl(this.serverUrl, target, path);
  }

  async readFile(target: CID): Promise<Uint8Array | null> {
    const response = await fetch(this.htreeUrl(target), { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Native readFile failed with ${response.status}`);
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async readFileRange(target: CID, start: number, end?: number): Promise<Uint8Array | null> {
    const response = await fetch(this.htreeUrl(target), {
      cache: 'no-store',
      headers: {
        Range: end === undefined ? `bytes=${start}-` : `bytes=${start}-${end}`,
      },
    });
    if (response.status === 404 || response.status === 416) return null;
    if (!response.ok) throw new Error(`Native readFileRange failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async *readFileStream(target: CID): AsyncGenerator<Uint8Array> {
    const response = await fetch(this.htreeUrl(target), { cache: 'no-store' });
    if (!response.ok || !response.body) {
      if (response.ok) {
        const data = await response.arrayBuffer();
        if (data.byteLength > 0) yield new Uint8Array(data);
        return;
      }
      throw new Error(`Native readFileStream failed with ${response.status}`);
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value && result.value.length > 0) {
          yield result.value;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async writeFile(): Promise<CID> {
    throw new Error('Native backend writeFile is not implemented');
  }

  async deleteFile(): Promise<CID> {
    throw new Error('Native backend deleteFile is not implemented');
  }

  async listDir(target: CID): Promise<WorkerDirEntry[]> {
    const response = await fetch(this.htreeUrl(target), { cache: 'no-store' });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Native listDir failed with ${response.status}`);
    const payload = await response.json() as DirListingResponse;
    return mapNativeDirEntries(payload);
  }

  async resolveRoot(npub: string, path?: string): Promise<CID | null> {
    if (!path) return null;
    const response = await fetch(
      `${this.serverUrl}/api/resolve/${encodeURIComponent(npub)}/${encodeURIComponent(path)}`,
      { cache: 'no-store' }
    );
    if (response.status === 404) return null;
    const payload = await response.json() as ResolveRootResponse;
    if (!response.ok || payload.error) return null;
    return decodeNativeResolvedRoot(payload);
  }

  subscribe(
    filters: WorkerNostrFilter[],
    callback?: (event: WorkerSignedEvent) => void,
    history?: (status?: HistoryStatus) => void,
  ): string {
    const subId = crypto.randomUUID();
    const sub = this.runtime.subscribe(filters as Filter[], {
      onEvent: event => {
        this.globalEventCallback?.(event);
        callback?.(event);
      },
      onEose: status => history?.(status),
    });
    this.subscriptions.set(subId, { sub });
    return subId;
  }

  queryEvents(filters: Filter[], options: RuntimeQueryOptions = {}) {
    return this.runtime.query(filters, options);
  }

  unsubscribe(subId: string): void {
    this.subscriptions.get(subId)?.sub.close();
    this.subscriptions.delete(subId);
  }

  async publish(event: WorkerSignedEvent): Promise<RuntimePublishResult> {
    return this.runtime.publish(event);
  }

  async getPeerStats(): Promise<WorkerPeerStats[]> {
    return [];
  }

  async getRelayStats(): Promise<WorkerRelayStats[]> {
    return this.runtime.getRelayStats().map(relay => ({ ...relay, eventsReceived: 0, eventsSent: 0 }));
  }

  async getStorageStats(): Promise<{ items: number; bytes: number }> {
    const response = await fetch(`${this.serverUrl}/api/stats`, { cache: 'no-store' });
    if (!response.ok) return { items: 0, bytes: 0 };
    const payload = await response.json() as {
      total_dags?: number;
      total_bytes?: number;
    };
    return {
      items: typeof payload.total_dags === 'number' ? payload.total_dags : 0,
      bytes: typeof payload.total_bytes === 'number' ? payload.total_bytes : 0,
    };
  }

  async blockPeer(_pubkey: string): Promise<void> {}

  async setBlossomServers(servers: WorkerBlossomServerConfig[]): Promise<void> {
    this.blossomServers = [...servers];
  }

  async setStorageMaxBytes(): Promise<void> {}

  async setRelays(relays: string[]): Promise<void> {
    this.relays = [...relays];
    this.runtime.setRelays(getEffectiveNostrRelayUrls(this.relays));
  }

  async setTreeRootCache(
    npub: string,
    treeName: string,
    hash: Uint8Array,
    key?: Uint8Array,
    visibility: 'public' | 'link-visible' | 'private' = 'public',
    _labels?: string[],
    _metadata?: NativeTreeRootCacheMetadata
  ): Promise<void> {
    await syncNativeTreeRootCache(npub, treeName, cid(hash, key), visibility);
  }

  async getTreeRootInfo(npub: string, treeName: string): Promise<TreeRootInfo | null> {
    const record = treeRootRegistry.getByKey(`${npub}/${treeName}`);
    if (record) {
      return {
        hash: record.hash,
        key: record.key,
        visibility: record.visibility,
        labels: record.labels,
        updatedAt: record.updatedAt,
        encryptedKey: record.encryptedKey,
        keyId: record.keyId,
        selfEncryptedKey: record.selfEncryptedKey,
        selfEncryptedLinkKey: record.selfEncryptedLinkKey,
      };
    }
    return null;
  }

  async mergeTreeRootKey(
    npub: string,
    treeName: string,
    hash: Uint8Array,
    key: Uint8Array
  ): Promise<boolean> {
    treeRootRegistry.mergeKey(npub, treeName, hash, key);
    const updated = treeRootRegistry.get(npub, treeName);
    if (updated) {
      await syncNativeTreeRootCache(npub, treeName, cid(updated.hash, updated.key), updated.visibility);
      return true;
    }
    return false;
  }

  async subscribeTreeRoots(): Promise<void> {}

  async unsubscribeTreeRoots(): Promise<void> {}

  registerMediaPort(_port: MessagePort, _debug?: boolean): void {}

  async initSocialGraph(rootPubkey?: string): Promise<{ version: number; size: number }> {
    if (rootPubkey) {
      this.socialGraphVersionCallback?.(1);
    }
    return { version: 0, size: 0 };
  }

  async setSocialGraphRoot(_pubkey: string): Promise<void> {
    this.socialGraphVersionCallback?.(1);
  }

  handleSocialGraphEvents(_events: SocialGraphEvent[]): void {}

  async getFollowDistance(_pubkey: string): Promise<number> {
    return 1000;
  }

  async isFollowing(follower: string, followed: string): Promise<boolean> {
    const follows = await this.getFollows(follower);
    return follows.includes(followed);
  }

  async getFollows(pubkey: string): Promise<string[]> {
    const { getFollowsSync } = await import('./stores/follows');
    const cached = getFollowsSync(pubkey);
    if (cached) return cached.follows;
    this.fetchUserFollows(pubkey);
    return getFollowsSync(pubkey)?.follows ?? [];
  }

  async getFollowers(_pubkey: string): Promise<string[]> {
    return [];
  }

  async getFollowedByFriends(_pubkey: string): Promise<string[]> {
    return [];
  }

  fetchUserFollows(pubkey: string): void {
    if (!pubkey || this.followsSubscriptions.has(pubkey)) return;
    void import('./stores/follows').then(({ createFollowsStore }) => {
      if (this.followsSubscriptions.has(pubkey)) return;
      this.followsSubscriptions.set(pubkey, createFollowsStore(pubkey));
    });
  }

  fetchUserFollowers(_pubkey: string): void {}

  async getSocialGraphSize(): Promise<number> {
    const myPubkey = nostrStore.getState().pubkey;
    if (!myPubkey) return 0;
    return (await this.getFollows(myPubkey)).length;
  }

  async getUsersByDistance(_distance: number): Promise<string[]> {
    return [];
  }

  async setIdentity(pubkey: string, nsec?: string): Promise<void> {
    this.identity = { pubkey, nsec };
  }

  close(): void {
    for (const { sub } of this.subscriptions.values()) {
      sub.close();
    }
    this.subscriptions.clear();
    for (const subscription of this.followsSubscriptions.values()) {
      subscription.destroy();
    }
    this.followsSubscriptions.clear();
    void this.runtime.close();
    this.globalEventCallback = null;
    this.blossomProgressCallback = null;
    this.blossomBandwidthCallback = null;
    this.blossomPushProgressCallback = null;
    this.blossomPushCompleteCallback = null;
    this.socialGraphVersionCallback = null;
  }
}

export async function initNativeBackend(config: RelayConfig): Promise<BackendAdapter> {
  const serverUrl = assertServerUrl(getRuntimeHtreeServerUrl());
  const adapter = new NativeBackendAdapter(serverUrl, config);
  await adapter.init();
  return adapter;
}
