import {
  LinkType,
  cid,
  fromHex,
  nhashDecode,
  nhashEncode,
  type CID,
  type WorkerBlossomBandwidthServerStats,
  type WorkerBlossomBandwidthStats,
  type WorkerBlossomServerConfig,
  type WorkerDirEntry,
} from '@hashtree/core';
import type { NDKSubscription } from 'ndk';

export type RelayConfig = {
  relays: string[];
  blossomServers?: WorkerBlossomServerConfig[];
  pubkey: string;
  nsec?: string;
  storeName?: string;
};

export type DirListingResponse = {
  entries?: Array<{
    name?: string;
    hash?: string;
    key?: string | null;
    size?: number;
    type?: string;
  }>;
};

export type ResolveRootResponse = {
  cid?: string;
  hash?: string;
  created_at?: number;
  encryptedKey?: string;
  keyId?: string;
  selfEncryptedKey?: string;
  selfEncryptedLinkKey?: string;
  error?: string;
};

export type SubscriptionRecord = {
  sub: NDKSubscription;
};

export type FollowsSubscription = {
  destroy: () => void;
};

export type NativeTreeRootUpdateCallback = (
  npub: string,
  treeName: string,
  hash: Uint8Array,
  updatedAt: number,
  options: {
    key?: Uint8Array;
    visibility: string;
    labels?: string[];
    encryptedKey?: string;
    keyId?: string;
    selfEncryptedKey?: string;
    selfEncryptedLinkKey?: string;
  }
) => void;

export type NativeTreeRootCacheMetadata = {
  encryptedKey?: string;
  keyId?: string;
  selfEncryptedKey?: string;
  selfEncryptedLinkKey?: string;
};

export const EMPTY_BLOSSOM_BANDWIDTH: WorkerBlossomBandwidthStats = {
  totalBytesSent: 0,
  totalBytesReceived: 0,
  updatedAt: 0,
  servers: [],
};

export function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

export function assertServerUrl(serverUrl: string | null): string {
  if (!serverUrl) {
    throw new Error('Native backend server URL is unavailable');
  }
  return normalizeServerUrl(serverUrl);
}

function typeToLinkType(value?: string): LinkType {
  switch ((value ?? '').toLowerCase()) {
    case 'dir':
      return LinkType.Dir;
    case 'file':
      return LinkType.File;
    default:
      return LinkType.Blob;
  }
}

export function cloneBlossomBandwidthStats(stats: WorkerBlossomBandwidthStats): WorkerBlossomBandwidthStats {
  return {
    totalBytesSent: stats.totalBytesSent,
    totalBytesReceived: stats.totalBytesReceived,
    updatedAt: Date.now(),
    servers: stats.servers.map((server) => ({ ...server })),
  };
}

export function addBlossomServerBytes(
  current: WorkerBlossomBandwidthStats,
  serverUrl: string,
  bytesSentDelta: number,
  bytesReceivedDelta: number,
): WorkerBlossomBandwidthStats {
  const normalized = normalizeServerUrl(serverUrl);
  const existing = new Map(
    current.servers.map((server) => [normalizeServerUrl(server.url), { ...server }])
  );
  const server = existing.get(normalized) ?? {
    url: normalized,
    bytesSent: 0,
    bytesReceived: 0,
  };
  server.bytesSent += Math.max(0, bytesSentDelta);
  server.bytesReceived += Math.max(0, bytesReceivedDelta);
  existing.set(normalized, server);
  return {
    totalBytesSent: current.totalBytesSent + Math.max(0, bytesSentDelta),
    totalBytesReceived: current.totalBytesReceived + Math.max(0, bytesReceivedDelta),
    updatedAt: Date.now(),
    servers: Array.from(existing.values()) as WorkerBlossomBandwidthServerStats[],
  };
}

export function createNativeHtreeUrl(serverUrl: string, target: CID, path?: string): string {
  const nhash = nhashEncode(target);
  const suffix = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `${serverUrl}/htree/${nhash}${suffix}`;
}

export function mapNativeDirEntries(payload: DirListingResponse): WorkerDirEntry[] {
  return (payload.entries ?? [])
    .filter((entry) => typeof entry.name === 'string' && typeof entry.hash === 'string')
    .map((entry) => ({
      name: entry.name!,
      isDir: typeToLinkType(entry.type) === LinkType.Dir,
      size: typeof entry.size === 'number' ? entry.size : 0,
      cid: cid(fromHex(entry.hash!), entry.key ? fromHex(entry.key) : undefined),
    }));
}

export function decodeNativeResolvedRoot(payload: ResolveRootResponse): CID | null {
  if (typeof payload.cid === 'string') {
    return nhashDecode(payload.cid);
  }
  if (typeof payload.hash === 'string') {
    return cid(fromHex(payload.hash));
  }
  return null;
}
