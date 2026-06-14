/**
 * NDK Setup for Main Thread
 *
 * Web mode talks to configured relays directly.
 * Native mode talks to the embedded daemon's local `/ws` relay so real relay
 * sockets and fanout stay off the UI thread.
 *
 * NIP-07 signing must happen in main thread (browser extension access).
 */
import NDK, { NDKEvent, NDKPrivateKeySigner, NDKNip07Signer, type NostrEvent } from 'ndk';
import { getRuntimeHtreeServerUrl, getRuntimeNostrRelays } from '../lib/htreeRuntime';
import {
  DEFAULT_RELAY_BANDWIDTH,
  transportUsageStore,
  type RelayBandwidthState,
} from '../stores/transportUsage';

// Minimal NDK instance for signing only - no relays, no cache
export const ndk = new NDK({
  explicitRelayUrls: [],
});

const textEncoder = new TextEncoder();
let relayBandwidthState: RelayBandwidthState = {
  totalBytesSent: DEFAULT_RELAY_BANDWIDTH.totalBytesSent,
  totalBytesReceived: DEFAULT_RELAY_BANDWIDTH.totalBytesReceived,
  updatedAt: DEFAULT_RELAY_BANDWIDTH.updatedAt,
  relays: [],
};
let relayBandwidthFlushTimer: ReturnType<typeof setTimeout> | null = null;

function publishRelayBandwidth(): void {
  relayBandwidthFlushTimer = null;
  relayBandwidthState = {
    totalBytesSent: relayBandwidthState.relays.reduce((sum, relay) => sum + relay.bytesSent, 0),
    totalBytesReceived: relayBandwidthState.relays.reduce((sum, relay) => sum + relay.bytesReceived, 0),
    updatedAt: Date.now(),
    relays: relayBandwidthState.relays.map((relay) => ({ ...relay })),
  };
  transportUsageStore.syncRelayBandwidth(relayBandwidthState);
}

function scheduleRelayBandwidthPublish(): void {
  if (relayBandwidthFlushTimer) return;
  relayBandwidthFlushTimer = setTimeout(() => {
    publishRelayBandwidth();
  }, 500);
}

function relayPayloadBytes(payload: unknown): number {
  if (typeof payload === 'string') {
    return textEncoder.encode(payload).length;
  }
  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }
  if (ArrayBuffer.isView(payload)) {
    return payload.byteLength;
  }
  if (payload instanceof Blob) {
    return payload.size;
  }
  return 0;
}

function trackRelayTraffic(relayUrl: string, direction: 'send' | 'recv', payload: unknown): void {
  const bytes = relayPayloadBytes(payload);
  if (bytes <= 0) return;

  const normalizedUrl = normalizeRelayUrl(relayUrl);
  const relays = relayBandwidthState.relays.slice();
  const index = relays.findIndex((relay) => relay.url === normalizedUrl);
  const current = index >= 0
    ? { ...relays[index] }
    : { url: normalizedUrl, bytesSent: 0, bytesReceived: 0 };

  if (direction === 'send') {
    current.bytesSent += bytes;
  } else {
    current.bytesReceived += bytes;
  }

  if (index >= 0) {
    relays[index] = current;
  } else {
    relays.push(current);
  }

  relayBandwidthState = {
    ...relayBandwidthState,
    relays,
  };
  scheduleRelayBandwidthPublish();
}

function attachRelayBandwidthHooks(): void {
  if (getNativeDaemonRelayUrl()) return;

  for (const relay of ndk.pool.relays.values()) {
    const connectivity = relay.connectivity as typeof relay.connectivity & {
      __irisRelayBandwidthHooked?: boolean;
    };
    if (connectivity.__irisRelayBandwidthHooked) continue;
    const previousNetDebug = connectivity.netDebug;
    connectivity.netDebug = (payload, relayRef, direction) => {
      previousNetDebug?.(payload, relayRef, direction);
      if (direction === 'send' || direction === 'recv') {
        trackRelayTraffic(relayRef.url, direction, payload);
      }
    };
    connectivity.__irisRelayBandwidthHooked = true;
  }
}

function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function uniqueRelayUrls(relays: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const relay of relays) {
    const url = normalizeRelayUrl(relay);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}

export function getNativeDaemonRelayUrl(): string | null {
  if (!getRuntimeHtreeServerUrl()) {
    return null;
  }
  return getRuntimeNostrRelays([])[0] ?? null;
}

export function getEffectiveNdkRelayUrls(relays: string[]): string[] {
  const effectiveRelays = getRuntimeNostrRelays(relays);
  return effectiveRelays.length > 0 ? effectiveRelays : uniqueRelayUrls(relays);
}

// Expose NDK on window for debugging
if (typeof window !== 'undefined') {
  (window as Window & { __ndk?: NDK }).__ndk = ndk;
}

/**
 * Unified sign function - works with both nsec and extension login
 */
export async function signEvent(event: NostrEvent): Promise<NostrEvent> {
  if (!ndk.signer) {
    throw new Error('No signing method available');
  }
  const ndkEvent = new NDKEvent(ndk, event);
  await ndkEvent.sign();
  return ndkEvent.rawEvent() as NostrEvent;
}

export async function configureNdkRelays(relays: string[], timeoutMs = 5000): Promise<void> {
  const normalized = getEffectiveNdkRelayUrls(relays);

  for (const relay of ndk.pool.relays.values()) {
    try {
      relay.disconnect();
    } catch {
      // Ignore disconnect errors while swapping relay sets.
    }
  }

  ndk.explicitRelayUrls = normalized;
  attachRelayBandwidthHooks();

  if (normalized.length === 0) {
    return;
  }

  const connectPromise = ndk.connect(timeoutMs);
  const timeoutPromise = new Promise<void>((_, reject) => {
    setTimeout(() => reject(new Error('Relay connect timeout')), timeoutMs);
  });

  await Promise.race([connectPromise, timeoutPromise]).catch(() => {
    // Native startup should continue even if relays are slow or unreachable.
  });
  attachRelayBandwidthHooks();
}

export function disconnectNdkRelays(): void {
  for (const relay of ndk.pool.relays.values()) {
    try {
      relay.disconnect();
    } catch {
      // Ignore disconnect errors during shutdown.
    }
  }
  ndk.explicitRelayUrls = [];
}

export function getNdkRelayStats(): Array<{
  url: string;
  connected: boolean;
  eventsReceived: number;
  eventsSent: number;
}> {
  const connectedRelayUrls = new Set(
    typeof ndk.pool?.connectedRelays === 'function'
      ? ndk.pool.connectedRelays().map((relay) => normalizeRelayUrl(relay.url))
      : [],
  );
  return Array.from(ndk.pool.relays.values()).map((relay) => ({
    url: relay.url,
    connected: connectedRelayUrls.has(normalizeRelayUrl(relay.url)) || relay.connectivity?.connected === true,
    eventsReceived: 0,
    eventsSent: 0,
  }));
}

export async function waitForNdkRelayConnection(maxWaitMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (getNdkRelayStats().some((relay) => relay.connected)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Re-export for convenience
export { NDKEvent, NDKPrivateKeySigner, NDKNip07Signer, type NostrEvent };
