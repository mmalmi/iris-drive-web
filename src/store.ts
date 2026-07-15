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
import { transportUsageStore, type RelayBandwidthState } from './stores/transportUsage';
import {
  advanceMeshBandwidthHistory,
  calculateMeshTotals,
  mergeMeshPeers,
  type MeshBandwidthHistoryPoint,
  type MeshHistoryCursor,
  type MeshPeerInfo,
} from './lib/meshStats';
import { getDriveFipsRuntime } from './lib/driveFipsRuntime';

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

export function stopWebRTC(): void {
  closeWorkerAdapter();
}

function fipsPeers(): PeerInfo[] {
  const stats = getDriveFipsRuntime()?.getStats();
  if (!stats) return [];
  return stats.peers.map((peer) => ({
    id: `fips:webrtc:${peer.peerId}`,
    peerId: peer.peerId,
    pubkey: peer.xOnlyPubkey,
    state: peer.connected ? 'connected' : 'disconnected',
    pool: 'others',
    bytesSent: 0,
    bytesReceived: 0,
    transport: 'fips-webrtc',
    source: 'worker',
    signalPaths: ['nostr'],
  }));
}

export async function refreshFipsStats(): Promise<void> {
  appStore.setPeerSources({ workerPeers: fipsPeers(), daemonPeers: [] });
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
