import {
  createHtreeRuntime,
  type BlossomServerConfig as WorkerBlossomServerConfig,
} from '@hashtree/worker';
import { get } from 'svelte/store';
import {
  DEFAULT_NETWORK_SETTINGS,
  settingsStore,
  type BlossomServerConfig as AppBlossomServerConfig,
} from '../stores/settings';

function getConfiguredRelays(): string[] {
  return get(settingsStore).network.relays ?? DEFAULT_NETWORK_SETTINGS.relays;
}

function getConfiguredBlossomServers(): WorkerBlossomServerConfig[] {
  return get(settingsStore).network.blossomServers ?? DEFAULT_NETWORK_SETTINGS.blossomServers;
}

const runtime = createHtreeRuntime({
  appId: 'iris-drive-web',
  relays: getConfiguredRelays,
  blossomServers: getConfiguredBlossomServers,
});

export function normalizeRuntimeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getHtreeRuntime() {
  return runtime;
}

function getCurrentLocation(): Location | null {
  if (typeof window === 'undefined') return null;
  return window.location;
}

function getLocationOrigin(location: Location): string | null {
  if (location.origin && location.origin !== 'null') {
    return normalizeRuntimeServerUrl(location.origin);
  }
  const host = location.host || (location.port ? `${location.hostname}:${location.port}` : location.hostname);
  if (!location.protocol || !host) return null;
  return normalizeRuntimeServerUrl(`${location.protocol}//${host}`);
}

export function getSameOriginIrisGatewayServerUrl(): string | null {
  const location = getCurrentLocation();
  if (!location || location.protocol !== 'http:') return null;
  const hostname = location.hostname.toLowerCase();
  if (hostname !== 'iris.localhost' && !hostname.endsWith('.iris.localhost')) {
    return null;
  }
  return getLocationOrigin(location);
}

export function isSameOriginIrisGatewayRuntime(): boolean {
  return !!getSameOriginIrisGatewayServerUrl();
}

export function getRuntimeHtreeServerUrl(): string | null {
  return getSameOriginIrisGatewayServerUrl() ?? runtime.endpoints.htreeServerUrl;
}

export function getRuntimeBlossomServer(): AppBlossomServerConfig | null {
  const url = getRuntimeHtreeServerUrl();
  if (!url) {
    return null;
  }
  return {
    url,
    read: true,
    write: true,
  };
}

function getRuntimeRelayUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else {
      return null;
    }
    url.pathname = '/ws';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function getRuntimeNostrRelays(relays: readonly string[]): string[] {
  const relay = getRuntimeHtreeServerUrl() ? getRuntimeRelayUrl(getRuntimeHtreeServerUrl()!) : null;
  if (relay) return [relay];
  return runtime.getEndpoints({ relays }).nostrRelays;
}

export function getRuntimeBlossomServers(
  servers: readonly AppBlossomServerConfig[],
): AppBlossomServerConfig[] {
  const runtimeServer = getRuntimeBlossomServer();
  if (!runtimeServer) {
    return runtime.getEndpoints({
      blossomServers: servers as readonly WorkerBlossomServerConfig[],
    }).blossomServers as AppBlossomServerConfig[];
  }

  const merged = new Map<string, AppBlossomServerConfig>();
  for (const server of [runtimeServer, ...servers]) {
    const url = normalizeRuntimeServerUrl(server.url);
    if (!url) continue;
    const existing = merged.get(url);
    if (existing) {
      merged.set(url, {
        url,
        read: Boolean(existing.read || server.read),
        write: Boolean(existing.write || server.write),
      });
    } else {
      merged.set(url, {
        url,
        read: server.read ?? true,
        write: server.write ?? false,
      });
    }
  }
  return Array.from(merged.values());
}

export function getRuntimeEndpoints(options: {
  relays?: readonly string[];
  blossomServers?: readonly AppBlossomServerConfig[];
} = {}) {
  return {
    htreeServerUrl: getRuntimeHtreeServerUrl(),
    nostrRelays: getRuntimeNostrRelays(options.relays ?? []),
    blossomServers: getRuntimeBlossomServers(options.blossomServers ?? []),
  };
}
