import type { RelayInfo, RelayStatus } from './store';

export interface RelayConnectionStat {
  url: string;
  connected: boolean;
}

export interface RelayStatusSnapshot {
  connectedRelays: number;
  relayStatuses: Map<string, RelayStatus>;
  discoveredRelays: RelayInfo[];
  transportRelays: RelayInfo[];
}

export function normalizeRelayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isLocalTransportRelay(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  } catch {
    return false;
  }
}

function relayStatusMapsEqual(a: Map<string, RelayStatus>, b: Map<string, RelayStatus>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a.entries()) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function relayInfoListsEqual(a: RelayInfo[], b: RelayInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((relay, index) =>
    relay.url === b[index]?.url && relay.status === b[index]?.status
  );
}

function sortRelayInfos(relays: RelayInfo[]): RelayInfo[] {
  return [...relays].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status === 'connected' ? -1 : 1;
    }
    return left.url.localeCompare(right.url);
  });
}

export function buildRelayStatusSnapshot(
  configuredRelays: string[],
  stats: RelayConnectionStat[],
): RelayStatusSnapshot {
  const configuredNormalized = new Set(configuredRelays.map(normalizeRelayUrl));
  const relayStatuses = new Map<string, RelayStatus>();
  const discoveredRelays: RelayInfo[] = [];
  const transportRelays: RelayInfo[] = [];
  const seenTransport = new Set<string>();
  let connectedRelays = 0;

  for (const url of configuredRelays) {
    relayStatuses.set(normalizeRelayUrl(url), 'disconnected');
  }

  for (const relay of stats) {
    const normalizedUrl = normalizeRelayUrl(relay.url);
    if (!normalizedUrl || seenTransport.has(normalizedUrl)) continue;
    seenTransport.add(normalizedUrl);

    const status: RelayStatus = relay.connected ? 'connected' : 'disconnected';
    transportRelays.push({ url: normalizedUrl, status });

    if (configuredNormalized.has(normalizedUrl)) {
      relayStatuses.set(normalizedUrl, status);
    } else if (!isLocalTransportRelay(normalizedUrl)) {
      discoveredRelays.push({ url: normalizedUrl, status });
    }

    if (relay.connected) {
      connectedRelays++;
    }
  }

  return {
    connectedRelays,
    relayStatuses,
    discoveredRelays: sortRelayInfos(discoveredRelays),
    transportRelays: sortRelayInfos(transportRelays),
  };
}

export { relayInfoListsEqual, relayStatusMapsEqual };
