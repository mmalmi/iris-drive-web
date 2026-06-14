/**
 * Shared state and store instances using Svelte stores.
 *
 * Storage architecture:
 * - backend store: primary storage adapter
 * - backend owns: local cache and Blossom fallback
 * - main thread: UI coordination only
 */
import { writable, get } from 'svelte/store';
import { HashTree, LinkType, type WorkerBlossomBandwidthStats } from '@hashtree/core';
import { getWorkerStore } from './stores/workerStore';
import { closeWorkerAdapter } from './workerAdapter';
import { getWorkerAdapter } from './lib/workerInit';
import { nostrStore } from './nostr';
import { transportUsageStore, type RelayBandwidthState } from './stores/transportUsage';
import {
  advanceMeshBandwidthHistory,
  calculateMeshTotals,
  fetchDaemonMeshStats,
  mergeMeshPeers,
  normalizeWorkerPeerStats,
  type MeshBandwidthHistoryPoint,
  type MeshHistoryCursor,
  type MeshPeerInfo,
} from './lib/meshStats';

// Re-export LinkType for e2e tests that can't import 'hashtree' directly
export { LinkType };

// Export localStore - always uses the active backend adapter.
// The backend must be initialized before using storage.
export const localStore = {
  async put(hash: Uint8Array, data: Uint8Array): Promise<boolean> {
    return getWorkerStore().put(hash, data);
  },
  async get(hash: Uint8Array): Promise<Uint8Array | null> {
    return getWorkerStore().get(hash);
  },
  async has(hash: Uint8Array): Promise<boolean> {
    return getWorkerStore().has(hash);
  },
  async delete(hash: Uint8Array): Promise<boolean> {
    return getWorkerStore().delete(hash);
  },
  async count(): Promise<number> {
    const adapter = getWorkerAdapter();
    if (!adapter) return 0;
    try {
      const stats = await adapter.getStorageStats();
      return stats.items;
    } catch {
      return 0;
    }
  },
  async totalBytes(): Promise<number> {
    const adapter = getWorkerAdapter();
    if (!adapter) return 0;
    try {
      const stats = await adapter.getStorageStats();
      return stats.bytes;
    } catch {
      return 0;
    }
  },
  clear(): void {
    console.warn('[localStore] clear() is not supported by the active backend');
  },
};

type DirectoryEntry = Awaited<ReturnType<HashTree['listDirectory']>>[number];

function internalChunkStart(name: string): number | null {
  const prefix = '_chunk_';
  if (!name.startsWith(prefix)) return null;

  const suffix = name.slice(prefix.length);
  if (suffix.length === 0 || !/^[0-9]+$/.test(suffix)) return null;

  const start = Number(suffix);
  return Number.isSafeInteger(start) ? start : null;
}

function entriesUseDirectoryFanout(entries: DirectoryEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => (
    entry.type === LinkType.Dir && internalChunkStart(entry.name) !== null
  ));
}

function addDirectoryFanoutCompatibility(tree: HashTree): HashTree {
  const baseListDirectory = tree.listDirectory.bind(tree);

  tree.listDirectory = async (id, signal) => {
    const entries = await baseListDirectory(id, signal);
    if (!entriesUseDirectoryFanout(entries)) {
      return entries;
    }

    const flattened: DirectoryEntry[] = [];
    const fanoutEntries = [...entries].sort((a, b) => (
      (internalChunkStart(a.name) ?? 0) - (internalChunkStart(b.name) ?? 0)
    ));

    for (const entry of fanoutEntries) {
      flattened.push(...await tree.listDirectory(entry.cid, signal));
    }

    return flattened;
  };

  return tree;
}

// HashTree instance - uses localStore which routes to the active backend
const _tree = addDirectoryFanoutCompatibility(new HashTree({ store: localStore }));

// Getter for tree - always returns current instance
export function getTree(): HashTree {
  return _tree;
}

// Storage stats
export interface StorageStats {
  items: number;
  bytes: number;
}

// Peer info for connectivity indicator / settings UI
export type PeerInfo = MeshPeerInfo;

// Detailed peer stats for getStats()
export interface DetailedPeerStats {
  id: string;
  peerId: string;
  pubkey: string;
  connected: boolean;
  pool: 'follows' | 'other';
  requestsSent: number;
  requestsReceived: number;
  responsesSent: number;
  responsesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  forwardedRequests: number;
  forwardedResolved: number;
  forwardedSuppressed: number;
  transport: string;
  source: 'worker' | 'daemon';
  signalPaths: string[];
}

export type BlossomBandwidthState = WorkerBlossomBandwidthStats;

const DEFAULT_BLOSSOM_BANDWIDTH: BlossomBandwidthState = {
  totalBytesSent: 0,
  totalBytesReceived: 0,
  updatedAt: 0,
  servers: [],
};

// App state store interface (simplified - mesh stats come from the active backend)
interface AppState {
  // Storage stats
  stats: StorageStats;
  // WebRTC peer count (from backend)
  peerCount: number;
  // Peer list for connectivity indicator
  peers: PeerInfo[];
  // Recent per-second mesh bandwidth samples
  meshBandwidthHistory: MeshBandwidthHistoryPoint[];
  meshUploadBandwidth: number;
  meshDownloadBandwidth: number;
  // Blossom bandwidth stats from backend
  blossomBandwidth: BlossomBandwidthState;
}

// Create Svelte store for app state
function createAppStore() {
  let workerPeers: PeerInfo[] = [];
  let daemonPeers: PeerInfo[] = [];
  let meshHistoryCursor: MeshHistoryCursor | null = null;

  const { subscribe, update } = writable<AppState>({
    stats: { items: 0, bytes: 0 },
    peerCount: 0,
    peers: [],
    meshBandwidthHistory: [],
    meshUploadBandwidth: 0,
    meshDownloadBandwidth: 0,
    blossomBandwidth: DEFAULT_BLOSSOM_BANDWIDTH,
  });

  const updatePeerState = () => {
    const peers = mergeMeshPeers(workerPeers, daemonPeers);
    const totals = calculateMeshTotals(peers);
    const sample = advanceMeshBandwidthHistory(
      meshHistoryCursor,
      get(appStore).meshBandwidthHistory,
      totals,
      Date.now(),
    );
    meshHistoryCursor = sample.nextCursor;
    transportUsageStore.syncPeers(peers);

    update(state => ({
      ...state,
      peers,
      peerCount: peers.filter(p => p.state === 'connected').length,
      meshBandwidthHistory: sample.history,
      meshUploadBandwidth: sample.rates.uploadBps,
      meshDownloadBandwidth: sample.rates.downloadBps,
    }));
  };

  return {
    subscribe,

    setStats: (stats: StorageStats) => {
      update(state => ({ ...state, stats }));
    },

    setPeerCount: (count: number) => {
      update(state => ({ ...state, peerCount: count }));
    },

    setPeers: (peers: PeerInfo[]) => {
      workerPeers = peers;
      updatePeerState();
    },

    setPeerSources: (sources: { workerPeers?: PeerInfo[]; daemonPeers?: PeerInfo[] }) => {
      workerPeers = sources.workerPeers ?? workerPeers;
      daemonPeers = sources.daemonPeers ?? daemonPeers;
      updatePeerState();
    },

    setDaemonPeers: (peers: PeerInfo[]) => {
      daemonPeers = peers;
      updatePeerState();
    },

    setBlossomBandwidth: (blossomBandwidth: BlossomBandwidthState) => {
      update(state => ({ ...state, blossomBandwidth }));
    },

    // Get current state synchronously (for compatibility)
    getState: (): AppState => get(appStore),
  };
}

export const appStore = createAppStore();

// Legacy compatibility alias
export const useAppStore = appStore;

// Expose for debugging in tests
if (typeof window !== 'undefined') {
  const win = window as Window & { __appStore?: typeof appStore; __localStore?: typeof localStore };
  win.__appStore = appStore;
  win.__localStore = localStore;
}

// Format bytes
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// Format bandwidth (bytes per second)
export function formatBandwidth(bytesPerSecond: number): string {
  if (bytesPerSecond < 1) return '0 B/s';
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

// Update storage stats from IDB
export async function updateStorageStats(): Promise<void> {
  try {
    const items = await localStore.count();
    const bytes = await localStore.totalBytes();
    appStore.setStats({ items, bytes });
  } catch {
    // Ignore errors
  }
}

// Decode content as text
export function decodeAsText(data: Uint8Array): string | null {
  if (data.length === 0) return '';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (!/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 1000))) {
      return text;
    }
  } catch {}
  return null;
}

// Stub functions for compatibility - WebRTC is now in worker
// These are called from nostr.ts on login/logout

export function initWebRTC(): void {
  // WebRTC is handled by worker - nothing to do here
  console.log('[Store] WebRTC initialization delegated to worker');
}

export function stopWebRTC(): void {
  // Close worker (clears identity, stops WebRTC, Nostr)
  closeWorkerAdapter();
}

// Legacy exports for compatibility - WebRTC is now in worker
// Create a proxy object that forwards to worker for test compatibility
const webrtcStoreProxy = {
  getPeers: () => get(appStore).peers.map(p => ({
    ...p,
    isConnected: p.state === 'connected',
  })),
  getConnectedCount: () => get(appStore).peers.filter(p => p.state === 'connected').length,
  get: async (hash: string) => {
    const adapter = getWorkerAdapter();
    if (!adapter) return null;
    return adapter.get(hash as unknown as Uint8Array);
  },
  setPoolConfig: (_config: unknown) => {
    // Pool config is managed by worker, no-op for now
  },
  setRelays: (_relays: string[]) => {
    // Relays are managed by worker, no-op for now
  },
  sendHello: () => {
    const adapter = getWorkerAdapter();
    adapter?.sendHello();
  },
  isFollowing: async (pubkey: string): Promise<boolean> => {
    const adapter = getWorkerAdapter();
    if (!adapter) return false;
    // Get current user's pubkey
    const myPubkey = nostrStore.getState().pubkey;
    if (!myPubkey) return false;
    try {
      return await adapter.isFollowing(myPubkey, pubkey);
    } catch {
      return false;
    }
  },
  getStats: async () => {
    const adapter = getWorkerAdapter();
    if (!adapter) {
      const daemonPeers = get(appStore).peers.filter((peer) => peer.source === 'daemon');
      const aggregate = {
        requestsSent: 0,
        requestsReceived: 0,
        responsesSent: 0,
        responsesReceived: 0,
        bytesSent: daemonPeers.reduce((sum, peer) => sum + peer.bytesSent, 0),
        bytesReceived: daemonPeers.reduce((sum, peer) => sum + peer.bytesReceived, 0),
        forwardedRequests: 0,
        forwardedResolved: 0,
        forwardedSuppressed: 0,
      };
      const perPeer = new Map<string, DetailedPeerStats>(
        daemonPeers.map((peer) => [peer.id, {
          id: peer.id,
          peerId: peer.peerId,
          pubkey: peer.pubkey,
          connected: peer.state === 'connected',
          pool: peer.pool === 'follows' ? 'follows' : 'other',
          requestsSent: 0,
          requestsReceived: 0,
          responsesSent: 0,
          responsesReceived: 0,
          bytesSent: peer.bytesSent,
          bytesReceived: peer.bytesReceived,
          forwardedRequests: 0,
          forwardedResolved: 0,
          forwardedSuppressed: 0,
          transport: peer.transport,
          source: peer.source,
          signalPaths: peer.signalPaths,
        }]),
      );
      return {
        aggregate,
        perPeer,
      };
    }

    const peerStats = await adapter.getPeerStats();

    // Aggregate stats from all peers
    const aggregate = {
      requestsSent: 0,
      requestsReceived: 0,
      responsesSent: 0,
      responsesReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      forwardedRequests: 0,
      forwardedResolved: 0,
      forwardedSuppressed: 0,
    };

    const perPeer = new Map<string, DetailedPeerStats>();

    for (const p of peerStats) {
      aggregate.requestsSent += p.requestsSent;
      aggregate.requestsReceived += p.requestsReceived;
      aggregate.responsesSent += p.responsesSent;
      aggregate.responsesReceived += p.responsesReceived;
      aggregate.bytesSent += p.bytesSent;
      aggregate.bytesReceived += p.bytesReceived;
      aggregate.forwardedRequests += p.forwardedRequests;
      aggregate.forwardedResolved += p.forwardedResolved;
      aggregate.forwardedSuppressed += p.forwardedSuppressed;

      const workerPeerId = `worker:webrtc:${p.peerId}`;
      perPeer.set(workerPeerId, {
        id: workerPeerId,
        peerId: p.peerId,
        pubkey: p.pubkey,
        connected: p.connected,
        pool: (p as { pool?: string }).pool === 'follows' ? 'follows' : 'other',
        requestsSent: p.requestsSent,
        requestsReceived: p.requestsReceived,
        responsesSent: p.responsesSent,
        responsesReceived: p.responsesReceived,
        bytesSent: p.bytesSent,
        bytesReceived: p.bytesReceived,
        forwardedRequests: p.forwardedRequests,
        forwardedResolved: p.forwardedResolved,
        forwardedSuppressed: p.forwardedSuppressed,
        transport: 'webrtc',
        source: 'worker',
        signalPaths: ['relay'],
      });
    }

    const daemonPeers = get(appStore).peers.filter((peer) => peer.source === 'daemon');
    for (const peer of daemonPeers) {
      aggregate.bytesSent += peer.bytesSent;
      aggregate.bytesReceived += peer.bytesReceived;
      perPeer.set(peer.id, {
        id: peer.id,
        peerId: peer.peerId,
        pubkey: peer.pubkey,
        connected: peer.state === 'connected',
        pool: peer.pool === 'follows' ? 'follows' : 'other',
        requestsSent: 0,
        requestsReceived: 0,
        responsesSent: 0,
        responsesReceived: 0,
        bytesSent: peer.bytesSent,
        bytesReceived: peer.bytesReceived,
        forwardedRequests: 0,
        forwardedResolved: 0,
        forwardedSuppressed: 0,
        transport: peer.transport,
        source: peer.source,
        signalPaths: peer.signalPaths,
      });
    }

    return { aggregate, perPeer };
  },
};
export const webrtcStore = webrtcStoreProxy;
export function getWebRTCStore() { return webrtcStoreProxy; }

export async function blockPeer(pubkey: string): Promise<void> {
  // Import dynamically to avoid circular dependency
  const { settingsStore } = await import('./stores/settings');
  settingsStore.blockPeer(pubkey);
  // Disconnect the peer via worker
  const adapter = getWorkerAdapter();
  if (adapter) {
    try {
      await adapter.blockPeer(pubkey);
    } catch {
      // Worker may not support blocking yet
    }
  }
}

export async function unblockPeer(pubkey: string): Promise<void> {
  // Import dynamically to avoid circular dependency
  const { settingsStore } = await import('./stores/settings');
  settingsStore.unblockPeer(pubkey);
}

// Expose webrtcStore on window for test compatibility
// Use defineProperty to allow testHelpers to override if needed
if (typeof window !== 'undefined' && !('webrtcStore' in window)) {
  Object.defineProperty(window, 'webrtcStore', {
    value: webrtcStoreProxy,
    writable: true,
    configurable: true,
  });
}

// Refresh WebRTC stats from worker
export async function refreshWebRTCStats(): Promise<void> {
  const adapter = getWorkerAdapter();
  const workerPromise = adapter
    ? adapter.getPeerStats()
      .then((stats) => normalizeWorkerPeerStats(stats))
      .catch((): PeerInfo[] => [])
    : Promise.resolve<PeerInfo[]>([]);
  const daemonPromise = fetchDaemonMeshStats()
    .catch(() => null);

  const [workerPeers, daemonStats] = await Promise.all([workerPromise, daemonPromise]);
  if (daemonStats) {
    setRelayBandwidth({
      totalBytesSent: daemonStats.relayBytesSent,
      totalBytesReceived: daemonStats.relayBytesReceived,
      updatedAt: Date.now(),
      relays: [],
    });
  }
  const daemonPeers = daemonStats?.peers ?? [];
  appStore.setPeerSources({ workerPeers, daemonPeers });
}

export function setBlossomBandwidth(stats: BlossomBandwidthState): void {
  const nextState = {
    totalBytesSent: stats.totalBytesSent,
    totalBytesReceived: stats.totalBytesReceived,
    updatedAt: stats.updatedAt,
    servers: stats.servers.map((server) => ({
      url: server.url,
      bytesSent: server.bytesSent,
      bytesReceived: server.bytesReceived,
    })),
  };
  appStore.setBlossomBandwidth(nextState);
  transportUsageStore.syncBlossomBandwidth(nextState);
}

export function setRelayBandwidth(stats: RelayBandwidthState): void {
  transportUsageStore.syncRelayBandwidth(stats);
}

export function getBandwidthUsageTotals() {
  const state = get(appStore);
  const meshTotals = calculateMeshTotals(state.peers);
  const blossomBytesSent = state.blossomBandwidth.totalBytesSent;
  const blossomBytesReceived = state.blossomBandwidth.totalBytesReceived;

  return {
    webrtcBytesSent: meshTotals.totalBytesSent,
    webrtcBytesReceived: meshTotals.totalBytesReceived,
    blossomBytesSent,
    blossomBytesReceived,
    totalBytesSent: meshTotals.totalBytesSent + blossomBytesSent,
    totalBytesReceived: meshTotals.totalBytesReceived + blossomBytesReceived,
    blossomServers: state.blossomBandwidth.servers,
    peers: state.peers,
  };
}

export function getLifetimeStats() {
  const usage = transportUsageStore.getState();
  const bytesSent = usage.lifetime.webrtc.bytesSent + usage.lifetime.bluetooth.bytesSent;
  const bytesReceived = usage.lifetime.webrtc.bytesReceived + usage.lifetime.bluetooth.bytesReceived;
  return { bytesSent, bytesReceived, bytesForwarded: 0 };
}
