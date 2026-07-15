import { getRuntimeHtreeServerUrl } from './htreeRuntime';

export type MeshPeerState = 'connected' | 'disconnected';
export type MeshPeerPool = 'follows' | 'others';
export type MeshPeerSource = 'worker' | 'daemon';
export type MeshTransport = 'webrtc' | 'bluetooth' | string;

export interface MeshPeerInfo {
  id: string;
  peerId: string;
  pubkey: string;
  state: MeshPeerState;
  pool: MeshPeerPool;
  bytesSent: number;
  bytesReceived: number;
  transport: MeshTransport;
  source: MeshPeerSource;
  signalPaths: string[];
}

export interface MeshTotals {
  totalBytesSent: number;
  totalBytesReceived: number;
}

export interface MeshHistoryCursor extends MeshTotals {
  timestamp: number;
}

export interface MeshBandwidthHistoryPoint extends MeshTotals {
  timestamp: number;
  uploadBps: number;
  downloadBps: number;
}

export interface DaemonMeshStats {
  enabled: boolean;
  peers: MeshPeerInfo[];
  totalBytesSent: number;
  totalBytesReceived: number;
  transportCounts: Record<string, number>;
  relayBytesSent: number;
  relayBytesReceived: number;
}

type WorkerPeerLike = {
  peerId: string;
  pubkey: string;
  connected: boolean;
  pool?: string;
  bytesSent: number;
  bytesReceived: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizePool(pool: string): MeshPeerPool {
  return pool.toLowerCase() === 'follows' ? 'follows' : 'others';
}

function makePeerId(source: MeshPeerSource, transport: MeshTransport, peerId: string): string {
  return `${source}:${transport}:${peerId}`;
}

export function normalizeWorkerPeerStats(stats: readonly WorkerPeerLike[]): MeshPeerInfo[] {
  return stats.map((peer) => ({
    id: makePeerId('worker', 'webrtc', peer.peerId),
    peerId: peer.peerId,
    pubkey: peer.pubkey,
    state: peer.connected ? 'connected' : 'disconnected',
    pool: normalizePool(peer.pool ?? ''),
    bytesSent: readNumber(peer.bytesSent),
    bytesReceived: readNumber(peer.bytesReceived),
    transport: 'webrtc',
    source: 'worker',
    signalPaths: ['relay'],
  }));
}

export function parseDaemonMeshSnapshot(payload: unknown): DaemonMeshStats {
  const root = asRecord(payload);
  const section = asRecord(root?.mesh) ?? asRecord(root?.webrtc) ?? root;
  if (!section || section.enabled !== true) {
    return {
      enabled: false,
      peers: [],
      totalBytesSent: 0,
      totalBytesReceived: 0,
      transportCounts: { webrtc: 0, bluetooth: 0 },
      relayBytesSent: 0,
      relayBytesReceived: 0,
    };
  }

  const rawPeers = Array.isArray(section.peers) ? section.peers : [];
  const peers = rawPeers
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => !!entry)
    .map((entry) => {
      const peerId = readString(entry.peer_id) || readString(entry.id);
      const transport = readString(entry.transport, 'webrtc');
      const connected = entry.connected === true || readString(entry.state).toLowerCase() === 'connected';
      const state: MeshPeerState = connected ? 'connected' : 'disconnected';
      return {
        id: makePeerId('daemon', transport, peerId),
        peerId,
        pubkey: readString(entry.pubkey),
        state,
        pool: normalizePool(readString(entry.pool)),
        bytesSent: readNumber(entry.bytes_sent),
        bytesReceived: readNumber(entry.bytes_received),
        transport,
        source: 'daemon' as const,
        signalPaths: readStringArray(entry.signal_paths),
      };
    });

  const transportCountsRecord = asRecord(section.transport_counts);
  const transportCounts = {
    webrtc: readNumber(transportCountsRecord?.webrtc),
    bluetooth: readNumber(transportCountsRecord?.bluetooth),
  };
  const relaySection = asRecord(root?.relay);

  return {
    enabled: true,
    peers,
    totalBytesSent: readNumber(section.bytes_sent) || calculateMeshTotals(peers).totalBytesSent,
    totalBytesReceived: readNumber(section.bytes_received) || calculateMeshTotals(peers).totalBytesReceived,
    transportCounts,
    relayBytesSent: readNumber(relaySection?.bytes_sent),
    relayBytesReceived: readNumber(relaySection?.bytes_received),
  };
}

export async function fetchDaemonMeshStats(): Promise<DaemonMeshStats | null> {
  const serverUrl = getRuntimeHtreeServerUrl();
  if (!serverUrl) return null;

  try {
    const response = await fetch(`${serverUrl}/api/status`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json();
    const stats = parseDaemonMeshSnapshot(payload);
    return stats.enabled ? stats : null;
  } catch {
    return null;
  }
}

export function mergeMeshPeers(...peerLists: readonly MeshPeerInfo[][]): MeshPeerInfo[] {
  const merged = new Map<string, MeshPeerInfo>();
  for (const peers of peerLists) {
    for (const peer of peers) {
      merged.set(peer.id, peer);
    }
  }

  return Array.from(merged.values()).sort((left, right) => {
    if (left.state !== right.state) {
      return left.state === 'connected' ? -1 : 1;
    }
    if (left.pool !== right.pool) {
      return left.pool === 'follows' ? -1 : 1;
    }
    if (left.transport !== right.transport) {
      return left.transport.localeCompare(right.transport);
    }
    return left.peerId.localeCompare(right.peerId);
  });
}

export function calculateMeshTotals(peers: readonly Pick<MeshPeerInfo, 'bytesSent' | 'bytesReceived'>[]): MeshTotals {
  return peers.reduce<MeshTotals>((totals, peer) => ({
    totalBytesSent: totals.totalBytesSent + readNumber(peer.bytesSent),
    totalBytesReceived: totals.totalBytesReceived + readNumber(peer.bytesReceived),
  }), {
    totalBytesSent: 0,
    totalBytesReceived: 0,
  });
}

export function advanceMeshBandwidthHistory(
  previous: MeshHistoryCursor | null,
  history: readonly MeshBandwidthHistoryPoint[],
  totals: MeshTotals,
  timestamp: number,
  maxPoints = 60,
): {
  nextCursor: MeshHistoryCursor;
  rates: { uploadBps: number; downloadBps: number };
  history: MeshBandwidthHistoryPoint[];
} {
  const nextCursor: MeshHistoryCursor = {
    timestamp,
    totalBytesSent: totals.totalBytesSent,
    totalBytesReceived: totals.totalBytesReceived,
  };

  if (!previous || previous.timestamp <= 0 || timestamp <= previous.timestamp) {
    return {
      nextCursor,
      rates: { uploadBps: 0, downloadBps: 0 },
      history: Array.from(history).slice(-Math.max(0, maxPoints - 1)).concat({
        timestamp,
        totalBytesSent: totals.totalBytesSent,
        totalBytesReceived: totals.totalBytesReceived,
        uploadBps: 0,
        downloadBps: 0,
      }),
    };
  }

  const elapsedSeconds = Math.max((timestamp - previous.timestamp) / 1000, 0.001);
  const uploadBytes = Math.max(0, totals.totalBytesSent - previous.totalBytesSent);
  const downloadBytes = Math.max(0, totals.totalBytesReceived - previous.totalBytesReceived);
  const point: MeshBandwidthHistoryPoint = {
    timestamp,
    totalBytesSent: totals.totalBytesSent,
    totalBytesReceived: totals.totalBytesReceived,
    uploadBps: uploadBytes / elapsedSeconds,
    downloadBps: downloadBytes / elapsedSeconds,
  };

  return {
    nextCursor,
    rates: { uploadBps: point.uploadBps, downloadBps: point.downloadBps },
    history: Array.from(history).slice(-Math.max(0, maxPoints - 1)).concat(point),
  };
}
