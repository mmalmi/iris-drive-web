import { writable } from 'svelte/store';
import type { WorkerBlossomBandwidthStats } from '@hashtree/core';

export const TRANSPORT_KINDS = ['relay', 'blossom', 'webrtc', 'bluetooth'] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export interface TransportUsageTotals {
  bytesSent: number;
  bytesReceived: number;
  updatedAt: number;
}

export type TransportUsageMap = Record<TransportKind, TransportUsageTotals>;

export interface TransportUsageState {
  session: TransportUsageMap;
  lifetime: TransportUsageMap;
}

export interface RelayBandwidthServerUsage {
  url: string;
  bytesSent: number;
  bytesReceived: number;
}

export interface RelayBandwidthState {
  totalBytesSent: number;
  totalBytesReceived: number;
  updatedAt: number;
  relays: RelayBandwidthServerUsage[];
}

interface PersistedSourceSnapshot {
  transport: TransportKind;
  bytesSent: number;
  bytesReceived: number;
  updatedAt: number;
}

interface PersistedTransportUsageState {
  version: 1;
  lifetime: TransportUsageMap;
  sources: Record<string, PersistedSourceSnapshot>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PeerUsageSample {
  id: string;
  transport: string;
  bytesSent: number;
  bytesReceived: number;
}

const STORAGE_KEY = 'iris-files:transport-usage:v1';
const SOURCE_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const DEFAULT_RELAY_BANDWIDTH: RelayBandwidthState = {
  totalBytesSent: 0,
  totalBytesReceived: 0,
  updatedAt: 0,
  relays: [],
};

export function createEmptyTransportUsageMap(): TransportUsageMap {
  return {
    relay: { bytesSent: 0, bytesReceived: 0, updatedAt: 0 },
    blossom: { bytesSent: 0, bytesReceived: 0, updatedAt: 0 },
    webrtc: { bytesSent: 0, bytesReceived: 0, updatedAt: 0 },
    bluetooth: { bytesSent: 0, bytesReceived: 0, updatedAt: 0 },
  };
}

function cloneTransportUsageMap(map: TransportUsageMap): TransportUsageMap {
  return {
    relay: { ...map.relay },
    blossom: { ...map.blossom },
    webrtc: { ...map.webrtc },
    bluetooth: { ...map.bluetooth },
  };
}

function normalizeTotals(value: unknown): TransportUsageTotals {
  if (!value || typeof value !== 'object') {
    return { bytesSent: 0, bytesReceived: 0, updatedAt: 0 };
  }
  const candidate = value as Partial<TransportUsageTotals>;
  return {
    bytesSent: typeof candidate.bytesSent === 'number' && candidate.bytesSent >= 0 ? candidate.bytesSent : 0,
    bytesReceived: typeof candidate.bytesReceived === 'number' && candidate.bytesReceived >= 0 ? candidate.bytesReceived : 0,
    updatedAt: typeof candidate.updatedAt === 'number' && candidate.updatedAt >= 0 ? candidate.updatedAt : 0,
  };
}

function normalizePersistedState(value: unknown): PersistedTransportUsageState {
  if (!value || typeof value !== 'object') {
    return {
      version: 1,
      lifetime: createEmptyTransportUsageMap(),
      sources: {},
    };
  }

  const candidate = value as Partial<PersistedTransportUsageState>;
  const lifetimeRecord = candidate.lifetime as Partial<Record<TransportKind, unknown>> | undefined;
  const sourceRecord = candidate.sources && typeof candidate.sources === 'object'
    ? candidate.sources as Record<string, PersistedSourceSnapshot>
    : {};

  const lifetime = createEmptyTransportUsageMap();
  for (const transport of TRANSPORT_KINDS) {
    lifetime[transport] = normalizeTotals(lifetimeRecord?.[transport]);
  }

  const sources: Record<string, PersistedSourceSnapshot> = {};
  for (const [sourceKey, snapshot] of Object.entries(sourceRecord)) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const transport = TRANSPORT_KINDS.includes(snapshot.transport)
      ? snapshot.transport
      : 'relay';
    sources[sourceKey] = {
      transport,
      bytesSent: typeof snapshot.bytesSent === 'number' && snapshot.bytesSent >= 0 ? snapshot.bytesSent : 0,
      bytesReceived: typeof snapshot.bytesReceived === 'number' && snapshot.bytesReceived >= 0 ? snapshot.bytesReceived : 0,
      updatedAt: typeof snapshot.updatedAt === 'number' && snapshot.updatedAt >= 0 ? snapshot.updatedAt : 0,
    };
  }

  return {
    version: 1,
    lifetime,
    sources,
  };
}

function getStorage(): StorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function applyDelta(
  usage: TransportUsageMap,
  transport: TransportKind,
  bytesSent: number,
  bytesReceived: number,
  updatedAt: number,
): void {
  if (bytesSent <= 0 && bytesReceived <= 0) return;
  const current = usage[transport];
  usage[transport] = {
    bytesSent: current.bytesSent + bytesSent,
    bytesReceived: current.bytesReceived + bytesReceived,
    updatedAt: Math.max(current.updatedAt, updatedAt),
  };
}

function computePersistentDelta(
  previous: PersistedSourceSnapshot | undefined,
  transport: TransportKind,
  bytesSent: number,
  bytesReceived: number,
): { bytesSent: number; bytesReceived: number } {
  if (!previous || previous.transport !== transport) {
    return { bytesSent, bytesReceived };
  }

  if (bytesSent < previous.bytesSent || bytesReceived < previous.bytesReceived) {
    return { bytesSent, bytesReceived };
  }

  return {
    bytesSent: Math.max(0, bytesSent - previous.bytesSent),
    bytesReceived: Math.max(0, bytesReceived - previous.bytesReceived),
  };
}

function computeRuntimeDelta(
  previous: PersistedSourceSnapshot | undefined,
  transport: TransportKind,
  bytesSent: number,
  bytesReceived: number,
): { bytesSent: number; bytesReceived: number } {
  if (!previous || previous.transport !== transport) {
    return { bytesSent: 0, bytesReceived: 0 };
  }

  if (bytesSent < previous.bytesSent || bytesReceived < previous.bytesReceived) {
    return { bytesSent, bytesReceived };
  }

  return {
    bytesSent: Math.max(0, bytesSent - previous.bytesSent),
    bytesReceived: Math.max(0, bytesReceived - previous.bytesReceived),
  };
}

function sumUsageMap(map: TransportUsageMap): TransportUsageTotals {
  return TRANSPORT_KINDS.reduce<TransportUsageTotals>((totals, transport) => ({
    bytesSent: totals.bytesSent + map[transport].bytesSent,
    bytesReceived: totals.bytesReceived + map[transport].bytesReceived,
    updatedAt: Math.max(totals.updatedAt, map[transport].updatedAt),
  }), { bytesSent: 0, bytesReceived: 0, updatedAt: 0 });
}

export class TransportUsageLedger {
  private readonly storage: StorageLike | null;
  private persisted: PersistedTransportUsageState;
  private readonly runtimeSession = createEmptyTransportUsageMap();
  private readonly runtimeSources = new Map<string, PersistedSourceSnapshot>();

  constructor(storage: StorageLike | null = getStorage()) {
    this.storage = storage;
    this.persisted = this.read();
  }

  private read(): PersistedTransportUsageState {
    if (!this.storage) {
      return {
        version: 1,
        lifetime: createEmptyTransportUsageMap(),
        sources: {},
      };
    }

    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) {
        return {
          version: 1,
          lifetime: createEmptyTransportUsageMap(),
          sources: {},
        };
      }
      return normalizePersistedState(JSON.parse(raw));
    } catch {
      return {
        version: 1,
        lifetime: createEmptyTransportUsageMap(),
        sources: {},
      };
    }
  }

  private write(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.persisted));
    } catch {
      // Ignore persistence failures.
    }
  }

  private prune(now: number): void {
    for (const [sourceKey, snapshot] of Object.entries(this.persisted.sources)) {
      if (now - snapshot.updatedAt > SOURCE_SNAPSHOT_TTL_MS) {
        delete this.persisted.sources[sourceKey];
      }
    }
  }

  snapshot(): TransportUsageState {
    return {
      session: cloneTransportUsageMap(this.runtimeSession),
      lifetime: cloneTransportUsageMap(this.persisted.lifetime),
    };
  }

  clearLifetime(): void {
    this.persisted = {
      version: 1,
      lifetime: createEmptyTransportUsageMap(),
      sources: {},
    };
    this.runtimeSources.clear();
    for (const transport of TRANSPORT_KINDS) {
      this.runtimeSession[transport] = { bytesSent: 0, bytesReceived: 0, updatedAt: 0 };
    }
    if (this.storage) {
      this.storage.removeItem(STORAGE_KEY);
    }
  }

  recordSource(
    sourceKey: string,
    transport: TransportKind,
    bytesSent: number,
    bytesReceived: number,
    updatedAt = Date.now(),
  ): TransportUsageState {
    const normalizedSent = Math.max(0, Math.floor(bytesSent));
    const normalizedReceived = Math.max(0, Math.floor(bytesReceived));
    const persistedPrevious = this.persisted.sources[sourceKey];
    const runtimePrevious = this.runtimeSources.get(sourceKey);

    const lifetimeDelta = computePersistentDelta(
      persistedPrevious,
      transport,
      normalizedSent,
      normalizedReceived,
    );
    const runtimeDelta = computeRuntimeDelta(
      runtimePrevious,
      transport,
      normalizedSent,
      normalizedReceived,
    );

    applyDelta(this.persisted.lifetime, transport, lifetimeDelta.bytesSent, lifetimeDelta.bytesReceived, updatedAt);
    applyDelta(this.runtimeSession, transport, runtimeDelta.bytesSent, runtimeDelta.bytesReceived, updatedAt);

    const nextSnapshot: PersistedSourceSnapshot = {
      transport,
      bytesSent: normalizedSent,
      bytesReceived: normalizedReceived,
      updatedAt,
    };
    this.persisted.sources[sourceKey] = nextSnapshot;
    this.runtimeSources.set(sourceKey, nextSnapshot);
    this.prune(updatedAt);
    this.write();
    return this.snapshot();
  }
}

function classifyPeerTransport(transport: string): TransportKind {
  return transport === 'bluetooth' ? 'bluetooth' : 'webrtc';
}

function createTransportUsageStore(storage: StorageLike | null = getStorage()) {
  const ledger = new TransportUsageLedger(storage);
  const { subscribe, set } = writable<TransportUsageState>(ledger.snapshot());

  function publish(): void {
    set(ledger.snapshot());
  }

  return {
    subscribe,
    getState(): TransportUsageState {
      return ledger.snapshot();
    },
    clearLifetime(): void {
      ledger.clearLifetime();
      publish();
    },
    syncBlossomBandwidth(stats: WorkerBlossomBandwidthStats): void {
      ledger.recordSource(
        'blossom:total',
        'blossom',
        stats.totalBytesSent,
        stats.totalBytesReceived,
        stats.updatedAt || Date.now(),
      );
      publish();
    },
    syncRelayBandwidth(stats: RelayBandwidthState): void {
      const updatedAt = stats.updatedAt || Date.now();
      if (stats.relays.length > 0) {
        for (const relay of stats.relays) {
          ledger.recordSource(
            `relay:${relay.url}`,
            'relay',
            relay.bytesSent,
            relay.bytesReceived,
            updatedAt,
          );
        }
      } else {
        ledger.recordSource(
          'relay:aggregate',
          'relay',
          stats.totalBytesSent,
          stats.totalBytesReceived,
          updatedAt,
        );
      }
      publish();
    },
    syncPeers(peers: readonly PeerUsageSample[]): void {
      const now = Date.now();
      for (const peer of peers) {
        ledger.recordSource(
          `peer:${peer.id}`,
          classifyPeerTransport(peer.transport),
          peer.bytesSent,
          peer.bytesReceived,
          now,
        );
      }
      publish();
    },
  };
}

export const transportUsageStore = createTransportUsageStore();

export function getTransportUsageTotals(state: TransportUsageState): {
  session: TransportUsageTotals;
  lifetime: TransportUsageTotals;
} {
  return {
    session: sumUsageMap(state.session),
    lifetime: sumUsageMap(state.lifetime),
  };
}
