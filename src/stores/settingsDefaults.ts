import { DEFAULT_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';
import { canUseInjectedHtreeServerUrl } from '../lib/nativeHtree';

export interface PoolSettings {
  showConnectivity: boolean;
  showBandwidth: boolean;
}

export type GitignoreBehavior = 'ask' | 'always' | 'never';

export interface UploadSettings {
  gitignoreBehavior: GitignoreBehavior;
}

export const isTestMode = !!import.meta.env.VITE_TEST_MODE;
const testRelay = import.meta.env.VITE_TEST_RELAY as string | undefined;
const testRelayOverride = typeof window !== 'undefined'
  ? (window as Window & { __testRelayUrl?: string }).__testRelayUrl
  : undefined;
const effectiveTestRelay = testRelayOverride ?? testRelay;

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  showConnectivity: false,
  showBandwidth: false,
};

export const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  gitignoreBehavior: 'ask',
};

export interface EditorSettings {
  autoSave: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autoSave: true,
};

export interface ImgproxySettings {
  enabled: boolean;
  url: string;
  key: string;
  salt: string;
}

export const DEFAULT_IMGPROXY_SETTINGS: ImgproxySettings = {
  enabled: true,
  url: 'https://imgproxy.iris.to',
  key: 'f66233cb160ea07078ff28099bfa3e3e654bc10aa4a745e12176c433d79b8996',
  salt: '5e608e60945dcd2a787e8465d76ba34149894765061d39287609fb9d776caa0c',
};

export interface StorageSettings {
  maxBytes: number;
}

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  maxBytes: 1024 * 1024 * 1024,
};

export interface BlossomServerConfig {
  url: string;
  read: boolean;
  write: boolean;
}

export interface NetworkSettings {
  relays: string[];
  blossomServers: BlossomServerConfig[];
  negentropyEnabled: boolean;
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  relays: isTestMode && effectiveTestRelay
    ? [effectiveTestRelay]
    : DEFAULT_PUBLIC_RELAYS,
  blossomServers: isTestMode
    ? []
    : [
        { url: 'https://upload.iris.to', read: false, write: true },
        { url: 'https://cdn.iris.to', read: true, write: false },
      ],
  negentropyEnabled: false,
};

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHostname(hostname: string | undefined): boolean {
  return !!hostname && LOCAL_HOSTNAMES.has(hostname);
}

function isLocalRelay(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function shouldApplyProductionFallback(): boolean {
  if (isTestMode) return false;
  if (typeof window === 'undefined') return false;
  if (canUseInjectedHtreeServerUrl()) return false;
  return !isLocalHostname(window.location.hostname);
}

export function applyProductionNetworkFallback(network: NetworkSettings): NetworkSettings {
  if (!shouldApplyProductionFallback()) return network;

  const relays = network.relays ?? [];
  const hasPublicRelay = relays.some(relay => !isLocalRelay(relay));
  const effectiveRelays = hasPublicRelay ? relays : DEFAULT_NETWORK_SETTINGS.relays;

  const blossomServers = network.blossomServers ?? [];
  const effectiveBlossom = blossomServers.length > 0 ? blossomServers : DEFAULT_NETWORK_SETTINGS.blossomServers;

  if (!hasPublicRelay || blossomServers.length === 0) {
    console.warn('[settings] Using default network fallbacks for this session');
  }

  return {
    ...network,
    relays: effectiveRelays,
    blossomServers: effectiveBlossom,
  };
}
