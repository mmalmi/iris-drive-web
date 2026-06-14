import { fromHex, type Hash } from '@hashtree/core';
import { DexieStore } from '@hashtree/dexie';
import {
  DEFAULT_FIPS_DISCOVERY_APP,
  HashtreeFipsTransport,
  createFipsNodeEndpoint,
  type FipsEndpoint,
  type FipsNodeLike,
} from '@hashtree/fips-transport';
import {
  FipsNode,
  identityFromSecretKey,
  npubFromHex,
  toHex,
  type FipsIdentity,
  type Logger,
  type PeerEvent,
  type SessionEvent,
} from '@fips/core';
import {
  WebRtcTransport,
} from '@fips/transport-webrtc';

export const IRIS_DRIVE_FIPS_DISCOVERY_SCOPE = DEFAULT_FIPS_DISCOVERY_APP;

const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RELAY_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_ICE_GATHER_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_REQUEST_RETRY_INTERVAL_MS = 750;
const DEFAULT_REQUEST_MAX_ATTEMPTS = 4;

export interface DriveFipsRuntimeOptions {
  deviceSecretKey: Uint8Array | string;
  ownerPubkeyHex?: string;
  relays: readonly string[];
  storeName?: string;
  stunServers?: readonly string[];
  maxConnections?: number;
  connectTimeoutMs?: number;
  relayConnectTimeoutMs?: number;
  iceGatherTimeoutMs?: number;
  requestTimeoutMs?: number;
  requestRetryIntervalMs?: number;
  requestMaxAttempts?: number;
  log?: boolean;
}

export interface DriveFipsPeerStats {
  peerId: string;
  xOnlyPubkey: string;
  npub: string;
  connected: boolean;
  lastStateAt: number;
  sessionsEstablished: number;
  lastSessionAt?: number;
}

export interface DriveFipsRuntimeStats {
  active: boolean;
  discoveryScope: string;
  relays: string[];
  localPeerId: string;
  localXOnlyPubkey: string;
  localNpub: string;
  connectedPeerIds: string[];
  connectedNpubs: string[];
  peers: DriveFipsPeerStats[];
}

type MutablePeerStats = DriveFipsPeerStats;

let activeRuntime: DriveFipsRuntime | null = null;

export function irisDriveFipsDiscoveryScope(_ownerPubkeyHex?: string): string {
  return IRIS_DRIVE_FIPS_DISCOVERY_SCOPE;
}

export function compressedPubkeyHexToXOnly(peerId: string): string {
  const normalized = peerId.trim().toLowerCase();
  if (!isHex(normalized, 66) || (normalized.slice(0, 2) !== '02' && normalized.slice(0, 2) !== '03')) {
    throw new Error(`invalid compressed FIPS peer id: ${peerId}`);
  }
  return normalized.slice(2);
}

export function compressedPubkeyHexToNpub(peerId: string): string {
  return npubFromHex(compressedPubkeyHexToXOnly(peerId));
}

export function supportsDriveFipsRuntime(): boolean {
  return typeof window !== 'undefined'
    && typeof indexedDB !== 'undefined'
    && typeof WebSocket !== 'undefined'
    && typeof RTCPeerConnection !== 'undefined';
}

export async function startDriveFipsRuntime(options: DriveFipsRuntimeOptions): Promise<DriveFipsRuntime> {
  await stopDriveFipsRuntime();
  const runtime = new DriveFipsRuntime(options);
  await runtime.start();
  activeRuntime = runtime;
  return runtime;
}

export async function stopDriveFipsRuntime(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = null;
  await runtime?.stop();
}

export function getDriveFipsRuntime(): DriveFipsRuntime | null {
  return activeRuntime;
}

export class DriveFipsRuntime {
  private readonly options: DriveFipsRuntimeOptions;
  private readonly discoveryScope: string;
  private readonly relays: string[];
  private node: FipsNode | null = null;
  private endpoint: FipsEndpoint | null = null;
  private transport: HashtreeFipsTransport | null = null;
  private localStore: DexieStore | null = null;
  private localIdentity: FipsIdentity | null = null;
  private readonly peerStats = new Map<string, MutablePeerStats>();
  private readonly unsubs: Array<() => void> = [];

  constructor(options: DriveFipsRuntimeOptions) {
    this.options = options;
    this.discoveryScope = irisDriveFipsDiscoveryScope(options.ownerPubkeyHex);
    this.relays = normalizeRelayUrls(options.relays);
    if (this.relays.length === 0) {
      throw new Error('drive FIPS runtime needs at least one relay');
    }
  }

  async start(): Promise<void> {
    if (this.node) return;
    if (!supportsDriveFipsRuntime()) {
      throw new Error('browser FIPS runtime is not supported in this environment');
    }

    const identity = await identityFromSecretKey(readSecretKey(this.options.deviceSecretKey));
    const node = new FipsNode({
      identity,
      forwarding: true,
      logger: createLogger(this.options.log === true, 'drive-fips:node'),
      transports: [
        new WebRtcTransport({
          relays: this.relays,
          stunServers: [...(this.options.stunServers ?? DEFAULT_STUN_SERVERS)],
          advertiseOnNostr: true,
          acceptConnections: true,
          autoConnect: true,
          discoveryApp: this.discoveryScope,
          maxConnections: this.options.maxConnections ?? 8,
          connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          relayConnectTimeoutMs: this.options.relayConnectTimeoutMs ?? DEFAULT_RELAY_CONNECT_TIMEOUT_MS,
          iceGatherTimeoutMs: this.options.iceGatherTimeoutMs ?? DEFAULT_ICE_GATHER_TIMEOUT_MS,
          logger: createLogger(this.options.log === true, 'drive-fips:webrtc'),
        }),
      ],
    });

    const storeName = this.options.storeName ?? `iris-drive-fips:${this.discoveryScope}:${toHex(identity.xOnlyPubkey)}`;
    const localStore = new DexieStore(storeName);
    const endpoint = createFipsNodeEndpoint(node as unknown as FipsNodeLike);
    const transport = new HashtreeFipsTransport({
      endpoint,
      localStore,
      peers: () => endpoint.listPeerIds?.() ?? [],
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      requestRetryIntervalMs: this.options.requestRetryIntervalMs ?? DEFAULT_REQUEST_RETRY_INTERVAL_MS,
      requestMaxAttempts: this.options.requestMaxAttempts ?? DEFAULT_REQUEST_MAX_ATTEMPTS,
    });

    this.localIdentity = identity;
    this.node = node;
    this.localStore = localStore;
    this.endpoint = endpoint;
    this.transport = transport;
    this.unsubs.push(
      node.on('peer', (event) => this.handlePeerEvent(event as PeerEvent)),
      node.on('session', (event) => this.handleSessionEvent(event as SessionEvent)),
      node.on('error', (event) => {
        if (this.options.log === true) {
          console.warn('[drive-fips] node error', event);
        }
      }),
    );

    try {
      await node.start();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    for (const unsub of this.unsubs.splice(0)) {
      unsub();
    }
    this.transport?.close();
    this.transport = null;
    this.endpoint = null;
    this.localStore?.close();
    this.localStore = null;
    this.peerStats.clear();
    this.localIdentity = null;
    if (node) {
      await node.stop().catch(() => undefined);
    }
    if (activeRuntime === this) {
      activeRuntime = null;
    }
  }

  async fetchBlock(hashHex: string, peerIds?: readonly string[]): Promise<Uint8Array | null> {
    if (!this.transport) {
      throw new Error('drive FIPS runtime is not active');
    }
    return this.transport.get(fromHex(hashHex) as Hash, peerIds);
  }

  getStats(): DriveFipsRuntimeStats {
    const identity = this.localIdentity;
    const localPeerId = identity ? toHex(identity.publicKey) : '';
    const localXOnlyPubkey = identity ? toHex(identity.xOnlyPubkey) : '';
    const peers = Array.from(this.peerStats.values())
      .sort((left, right) => left.peerId.localeCompare(right.peerId));
    return {
      active: this.node !== null,
      discoveryScope: this.discoveryScope,
      relays: [...this.relays],
      localPeerId,
      localXOnlyPubkey,
      localNpub: localXOnlyPubkey ? npubFromHex(localXOnlyPubkey) : '',
      connectedPeerIds: peers.filter((peer) => peer.connected).map((peer) => peer.peerId),
      connectedNpubs: peers.filter((peer) => peer.connected).map((peer) => peer.npub),
      peers,
    };
  }

  private handlePeerEvent(event: PeerEvent): void {
    const remotePubkey = normalizeCompressedPeerId(event.remotePubkey);
    if (!remotePubkey) return;
    const stats = this.ensurePeerStats(remotePubkey);
    stats.connected = event.state === 'connected';
    stats.lastStateAt = Date.now();
  }

  private handleSessionEvent(event: SessionEvent): void {
    const remotePubkey = normalizeCompressedPeerId(event.remotePubkey);
    if (!remotePubkey || event.state !== 'established') return;
    const stats = this.ensurePeerStats(remotePubkey);
    stats.sessionsEstablished += 1;
    stats.lastSessionAt = Date.now();
  }

  private ensurePeerStats(peerId: string): MutablePeerStats {
    let stats = this.peerStats.get(peerId);
    if (!stats) {
      stats = {
        peerId,
        xOnlyPubkey: compressedPubkeyHexToXOnly(peerId),
        npub: compressedPubkeyHexToNpub(peerId),
        connected: false,
        lastStateAt: Date.now(),
        sessionsEstablished: 0,
      };
      this.peerStats.set(peerId, stats);
    }
    return stats;
  }
}

function readSecretKey(secret: Uint8Array | string): Uint8Array {
  const bytes = typeof secret === 'string' ? fromHex(secret) : new Uint8Array(secret);
  if (bytes.length !== 32) {
    throw new Error(`drive FIPS device secret must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

function normalizeRelayUrls(relays: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const relay of relays) {
    const normalized = relay.trim().replace(/\/+$/, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeCompressedPeerId(peerId: string): string | null {
  const normalized = peerId.trim().toLowerCase();
  if (!isHex(normalized, 66)) return null;
  if (normalized.slice(0, 2) !== '02' && normalized.slice(0, 2) !== '03') return null;
  return normalized;
}

function isHex(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-f]+$/i.test(value);
}

function createLogger(enabled: boolean, scope: string): Logger {
  if (!enabled) {
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
  }
  return {
    debug: (...args: unknown[]) => console.debug(`[${scope}]`, ...args),
    info: (...args: unknown[]) => console.info(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${scope}]`, ...args),
  };
}
