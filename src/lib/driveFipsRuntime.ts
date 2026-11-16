import {
  localIndexSource,
  type NostrEvent,
  type NostrFilter,
  type PublicPeerFeedSource,
  type RuntimeSource,
} from 'nostr-pubsub';
import { DexieStore } from '@hashtree/dexie';
import { BLOB_DEFAULT_HTL } from '@hashtree/core';
import {
  DEFAULT_FIPS_DISCOVERY_APP,
} from '@hashtree/fips-transport';
import {
  createBrowserHashtreeNostrProvider,
  type BrowserHashtreeNostrProvider,
} from '@hashtree/fips-transport/browser';
import type { FipsBlobRoute } from '@hashtree/fips-transport/worker';
import {
  identityFromSecretKey,
  npubFromHex,
  toHex,
  type FipsIdentity,
  type Logger,
  type PeerEvent,
  type SessionEvent,
} from '@fips/core';
import { followDriveRosterPeers } from './driveFipsRosterDiscovery';
import { decodeDriveFipsSecretKey } from './driveFipsIdentity';
import { registerDriveFipsRuntimeGetter } from './driveFipsRuntimeRef';

export const IRIS_DRIVE_FIPS_DISCOVERY_SCOPE = DEFAULT_FIPS_DISCOVERY_APP;

const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_RELAY_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_ICE_GATHER_TIMEOUT_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
// Peer events and roster changes refresh admission when they happen; this only
// keeps the relay-checked roster from going stale while nothing happens.
const AUTHORIZATION_REFRESH_MS = 3 * 60_000;
// The kinds @hashtree/fips-transport opens its peer feed with.
const PUBLIC_FEED_KINDS = [0, 1, 3, 5, 6, 7, 16, 20, 1111, 30023, 30064];
// The account's device roster (7368), and Drive's roots, notes and device
// reports (30078).
const DRIVE_EVENT_KINDS = [7368, 30078];
const KEEP_BATCH = 64;

export type DriveFipsAuthorizedAppKeySource = (
  () => readonly string[] | Promise<readonly string[]>
);

export interface DriveFipsRuntimeOptions {
  relays: readonly string[];
  websocketSeedUrls?: readonly string[];
  deviceSecretKey: string | Uint8Array;
  profileId?: string;
  storeName?: string;
  stunServers?: readonly string[];
  maxConnections?: number;
  connectTimeoutMs?: number;
  relayConnectTimeoutMs?: number;
  iceGatherTimeoutMs?: number;
  requestTimeoutMs?: number;
  authorizedAppKeyPubkeys: DriveFipsAuthorizedAppKeySource;
  /**
   * The app keys of the roster this device holds, for preferring routes to
   * blocks. Reading blocks never waits for the relay check of the roster.
   */
  routeAppKeyPubkeys?: () => readonly string[];
  /** Events this device holds, so it can pass them to the account's other devices. */
  storedEvents?: (filters: NostrFilter[]) => Promise<NostrEvent[]>;
  /** Keep events the account's other devices sent here. */
  keepEvents?: (events: NostrEvent[]) => Promise<void>;
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
  nostrPeerIds: string[];
  peers: DriveFipsPeerStats[];
}

type MutablePeerStats = DriveFipsPeerStats;

let activeRuntime: DriveFipsRuntime | null = null;
let runtimeGeneration = 0;

export function irisDriveFipsDiscoveryScope(_profileId?: string): string {
  // Block service discovery is shared across profiles and applications.
  return IRIS_DRIVE_FIPS_DISCOVERY_SCOPE;
}

export async function driveFipsIdentityFromAppKeySecret(
  secret: string | Uint8Array,
): Promise<FipsIdentity> {
  return identityFromSecretKey(decodeDriveFipsSecretKey(secret));
}

export function attachDriveFipsProvider<Provider>(
  adapter: { setP2PProvider?: (provider: Provider | null) => void },
  runtime: { getP2PProvider(): Provider },
): Provider {
  if (!adapter.setP2PProvider) {
    throw new Error('worker adapter does not support an external FIPS provider');
  }
  const provider = runtime.getP2PProvider();
  adapter.setP2PProvider(provider);
  return provider;
}

export class DriveFipsPeerPolicy {
  private readonly localAppKeyPubkey: string;

  constructor(
    localAppKeyPubkey: string,
    private readonly authorizedAppKeyPubkeys: DriveFipsAuthorizedAppKeySource,
    private readonly routeAppKeyPubkeys?: () => readonly string[],
  ) {
    const normalized = normalizeAppKeyPubkey(localAppKeyPubkey);
    if (!normalized) throw new Error('local Drive AppKey pubkey is invalid');
    this.localAppKeyPubkey = normalized;
  }

  async providerRoutes(): Promise<FipsBlobRoute[]> {
    // Roster peers are preferred routes, not a block-serving access list.
    // The shared provider also discovers advertised Hashtree services.
    const authorized = this.routeAppKeyPubkeys
      ? normalizedAppKeys(this.routeAppKeyPubkeys())
      : await this.authorizedAppKeys();
    return [...authorized]
      .filter((pubkey) => pubkey !== this.localAppKeyPubkey)
      .sort()
      .flatMap((pubkey) => compressedFipsPeerIds(pubkey).map((peerId) => ({
        peerId,
        htl: BLOB_DEFAULT_HTL,
      })));
  }

  /** This account's devices, this one included, as the roster held here says. */
  ownDevices(): string[] {
    if (!this.routeAppKeyPubkeys) return [this.localAppKeyPubkey];
    return [...new Set([this.localAppKeyPubkey, ...normalizedAppKeys(this.routeAppKeyPubkeys())])].sort();
  }

  async nostrPeers(connectedPeerIds: readonly string[]): Promise<string[]> {
    const authorized = await this.authorizedAppKeys();
    return connectedPeerIds.filter((peerId) => {
      const appKeyPubkey = fipsPeerAppKeyPubkey(peerId);
      return appKeyPubkey !== null && authorized.has(appKeyPubkey);
    }).sort();
  }

  private async authorizedAppKeys(): Promise<Set<string>> {
    return normalizedAppKeys(await this.authorizedAppKeyPubkeys());
  }
}

function normalizedAppKeys(pubkeys: readonly string[]): Set<string> {
  return new Set(pubkeys.flatMap((pubkey) => {
    const normalized = normalizeAppKeyPubkey(pubkey);
    return normalized ? [normalized] : [];
  }));
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
  const generation = ++runtimeGeneration;
  const previous = activeRuntime;
  activeRuntime = null;
  await previous?.stop();
  const runtime = new DriveFipsRuntime(options);
  await runtime.start();
  if (generation !== runtimeGeneration) {
    await runtime.stop();
    throw new Error('drive FIPS runtime start superseded');
  }
  activeRuntime = runtime;
  return runtime;
}

export async function stopDriveFipsRuntime(): Promise<void> {
  runtimeGeneration += 1;
  const runtime = activeRuntime;
  activeRuntime = null;
  await runtime?.stop();
}

export function getDriveFipsRuntime(): DriveFipsRuntime | null {
  return activeRuntime;
}

registerDriveFipsRuntimeGetter(getDriveFipsRuntime);

export class DriveFipsRuntime {
  private readonly options: DriveFipsRuntimeOptions;
  private readonly discoveryScope: string;
  private readonly relays: string[];
  private provider: BrowserHashtreeNostrProvider | null = null;
  private closeRosterDiscovery?: () => Promise<void>;
  private localStore: DexieStore | null = null;
  private localIdentity: FipsIdentity | null = null;
  private peerPolicy: DriveFipsPeerPolicy | null = null;
  private nostrPeerIds: string[] = [];
  private authorizationRefreshGeneration = 0;
  private authorizationRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly peerStats = new Map<string, MutablePeerStats>();
  private readonly unsubs: Array<() => void> = [];
  /** Drive events already handed to the peer feed or received from it. */
  private readonly passedEventIds = new Set<string>();
  private passDue = true;
  private keptEvents: NostrEvent[] = [];
  private keepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DriveFipsRuntimeOptions) {
    this.options = options;
    this.discoveryScope = irisDriveFipsDiscoveryScope(options.profileId);
    this.relays = normalizeRelayUrls(options.relays);
  }

  async start(): Promise<void> {
    if (this.provider) return;
    if (!supportsDriveFipsRuntime()) {
      throw new Error('browser FIPS runtime is not supported in this environment');
    }

    const identity = await driveFipsIdentityFromAppKeySecret(this.options.deviceSecretKey);
    const peerPolicy = new DriveFipsPeerPolicy(
      toHex(identity.xOnlyPubkey),
      this.options.authorizedAppKeyPubkeys,
      this.options.routeAppKeyPubkeys,
    );
    const storeName = this.options.storeName ?? 'hashtree-worker';
    const localStore = new DexieStore(storeName);
    let provider: BrowserHashtreeNostrProvider;
    try {
      provider = await createBrowserHashtreeNostrProvider({
        identity,
        localStore,
        // Nostr traffic keeps roster admission;
        // raw content-addressed blocks use the standard authenticated service.
        nostrPeers: () => [...this.nostrPeerIds],
        discoveryApp: this.discoveryScope,
        forwarding: true,
        logger: createLogger(this.options.log === true, 'drive-fips:node'),
        relays: this.relays,
        websocketSeedUrls: this.options.websocketSeedUrls,
        stunServers: [...(this.options.stunServers ?? DEFAULT_STUN_SERVERS)],
        maxConnections: this.options.maxConnections ?? 8,
        connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        relayConnectTimeoutMs: this.options.relayConnectTimeoutMs ?? DEFAULT_RELAY_CONNECT_TIMEOUT_MS,
        iceGatherTimeoutMs: this.options.iceGatherTimeoutMs ?? DEFAULT_ICE_GATHER_TIMEOUT_MS,
        requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        providerRoutes: () => peerPolicy.providerRoutes(),
      });
    } catch (error) {
      localStore.close();
      throw error;
    }

    this.localIdentity = identity;
    this.peerPolicy = peerPolicy;
    this.provider = provider;
    this.localStore = localStore;
    this.authorizationRefreshTimer = setInterval(() => {
      this.passDue = true;
      void this.refreshNostrPeerAuthorization();
    }, AUTHORIZATION_REFRESH_MS);
    this.unsubs.push(
      provider.node.on('peer', (event) => {
        void this.handlePeerEvent(event as PeerEvent);
      }),
      provider.node.on('session', (event) => this.handleSessionEvent(event as SessionEvent)),
      provider.node.on('error', (event) => {
        if (this.options.log === true) {
          console.warn('[drive-fips] node error', event);
        }
      }),
    );
    if (this.options.profileId) {
      try {
        this.closeRosterDiscovery = await followDriveRosterPeers(
          this.options.profileId, identity, provider, this.relays,
          [...(this.options.stunServers ?? DEFAULT_STUN_SERVERS)], () => peerPolicy.ownDevices(),
        );
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    // Blocks still move over FIPS if the event feed cannot open.
    await this.openDriveEventFeed(provider).catch((error: unknown) => {
      console.warn('[drive-fips] Drive event feed did not open:', error);
    });
    // A bootstrap link may already be connected before node.start returns.
    for (const peerId of provider.listConnectedPeerIds()) {
      const normalized = normalizeCompressedPeerId(peerId);
      if (normalized) this.ensurePeerStats(normalized).connected = true;
    }
    await this.refreshNostrPeerAuthorization();
  }

  async stop(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    this.authorizationRefreshGeneration += 1;
    this.nostrPeerIds = [];
    for (const unsub of this.unsubs.splice(0)) {
      unsub();
    }
    await this.closeRosterDiscovery?.();
    this.closeRosterDiscovery = undefined;
    if (provider) {
      await provider.stop().catch(() => undefined);
    }
    if (this.authorizationRefreshTimer) clearInterval(this.authorizationRefreshTimer);
    this.authorizationRefreshTimer = null;
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    void this.flushKeptEvents();
    this.passedEventIds.clear();
    this.passDue = true;
    this.localStore?.close();
    this.localStore = null;
    this.peerStats.clear();
    this.peerPolicy = null;
    this.localIdentity = null;
    if (activeRuntime === this) {
      activeRuntime = null;
    }
  }

  getP2PProvider(): BrowserHashtreeNostrProvider {
    if (!this.provider) {
      throw new Error('drive FIPS runtime is not active');
    }
    return this.provider;
  }

  getNostrSource(): RuntimeSource { return this.getP2PProvider().nostrSource; }

  /** Re-admit peers after the Drive roster changed. */
  refreshAuthorization(): void {
    void this.refreshNostrPeerAuthorization();
  }

  getStats(): DriveFipsRuntimeStats {
    const identity = this.localIdentity;
    const localPeerId = identity ? toHex(identity.publicKey) : '';
    const localXOnlyPubkey = identity ? toHex(identity.xOnlyPubkey) : '';
    const peers = Array.from(this.peerStats.values())
      .sort((left, right) => left.peerId.localeCompare(right.peerId));
    return {
      active: this.provider !== null,
      discoveryScope: this.discoveryScope,
      relays: [...this.relays],
      localPeerId,
      localXOnlyPubkey,
      localNpub: localXOnlyPubkey ? npubFromHex(localXOnlyPubkey) : '',
      connectedPeerIds: peers.filter((peer) => peer.connected).map((peer) => peer.peerId),
      connectedNpubs: peers.filter((peer) => peer.connected).map((peer) => peer.npub),
      nostrPeerIds: [...this.nostrPeerIds],
      peers,
    };
  }

  private async handlePeerEvent(event: PeerEvent): Promise<void> {
    const remotePubkey = normalizeCompressedPeerId(event.remotePubkey);
    if (!remotePubkey) return;
    const stats = this.ensurePeerStats(remotePubkey);
    stats.connected = event.state === 'connected';
    stats.lastStateAt = Date.now();
    await this.refreshNostrPeerAuthorization();
  }

  private async refreshNostrPeerAuthorization(): Promise<void> {
    const policy = this.peerPolicy;
    const provider = this.provider;
    if (!policy || !provider) return;
    const generation = ++this.authorizationRefreshGeneration;
    const [peers, ownDevices] = await Promise.all([
      policy.nostrPeers(this.getStats().connectedPeerIds).catch(() => []),
      policy.providerRoutes().catch(() => []),
    ]);
    if (generation !== this.authorizationRefreshGeneration || provider !== this.provider) return;
    // Before a device of this account is admitted, the feed holds what this
    // device has stored, so Negentropy sends each side only what it lacks.
    if (this.passDue || peers.some((peer) => !this.nostrPeerIds.includes(peer))) {
      this.passDue = false;
      await this.passStoredDriveEvents(provider, policy.ownDevices());
      if (generation !== this.authorizationRefreshGeneration || provider !== this.provider) return;
    }
    this.nostrPeerIds = peers;
    // This account's other devices are dialed before strangers and redialed
    // soon after a failure, so they find each other directly.
    provider.webRtcTransport.setPreferredAutoConnectPeers(ownDevices.map((route) => route.peerId));
    provider.refreshNostrPeers();
  }

  /**
   * Drive's own events travel over the FIPS peer feed too. Its event peers
   * are this account's devices only, so a device that cannot reach relays
   * still gets the other devices' roots and reports.
   */
  private async openDriveEventFeed(provider: BrowserHashtreeNostrProvider): Promise<void> {
    const feed = provider.nostrSource as RuntimeSource & Partial<PublicPeerFeedSource>;
    if (!feed.replaceFeed || !feed.subscribe) return;
    await feed.replaceFeed([
      { type: 'latest', kinds: PUBLIC_FEED_KINDS },
      { type: 'latest', kinds: DRIVE_EVENT_KINDS },
    ]);
    const subscription = await feed.subscribe([{ kinds: DRIVE_EVENT_KINDS }], ({ event }) => {
      if (this.provider !== provider || this.passedEventIds.has(event.id)) return;
      this.passedEventIds.add(event.id);
      this.keptEvents.push(event);
      this.keepTimer ??= setTimeout(() => void this.flushKeptEvents(), 50);
    });
    this.unsubs.push(() => subscription.close());
  }

  /** Received events are stored even when nothing on the page asked for them. */
  private async flushKeptEvents(): Promise<void> {
    this.keepTimer = null;
    const events = this.keptEvents.splice(0);
    for (let index = 0; index < events.length; index += KEEP_BATCH) {
      await this.options.keepEvents?.(events.slice(index, index + KEEP_BATCH)).catch((error: unknown) => {
        if (this.options.log === true) console.warn('[drive-fips] could not keep events', error);
      });
    }
  }

  private async passStoredDriveEvents(provider: BrowserHashtreeNostrProvider, authors: string[]): Promise<void> {
    const source = provider.nostrSource;
    if (!this.options.storedEvents || !source.publish || authors.length === 0) return;
    const events = await this.options.storedEvents([{ kinds: DRIVE_EVENT_KINDS, authors }]).catch(() => []);
    const origin = localIndexSource('drive-stored-events');
    await Promise.allSettled(events.flatMap((event) => {
      if (this.passedEventIds.has(event.id)) return [];
      this.passedEventIds.add(event.id);
      // With no device admitted yet this only fills the feed's inventory.
      return [source.publish!(event, origin)];
    }));
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

function normalizeAppKeyPubkey(pubkey: string): string | null {
  const normalized = pubkey.trim().toLowerCase();
  return isHex(normalized, 64) ? normalized : null;
}

function compressedFipsPeerIds(appKeyPubkey: string): [string, string] {
  // A Drive roster stores the BIP-340 x-only AppKey. FIPS addresses use a
  // compressed secp256k1 key, whose parity cannot be recovered from x alone.
  return [`02${appKeyPubkey}`, `03${appKeyPubkey}`];
}

function fipsPeerAppKeyPubkey(peerId: string): string | null {
  return normalizeCompressedPeerId(peerId)?.slice(2) ?? null;
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
