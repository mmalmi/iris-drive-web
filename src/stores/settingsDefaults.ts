import { DEFAULT_PUBLIC_RELAYS } from '../lib/defaultRelays';
import { canUseInjectedHtreeServerUrl } from '../lib/nativeHtree';

export type WebRTCUploadRateLimitMode = 'auto' | 'custom';

export interface PoolSettings {
  followsMax: number;
  followsSatisfied: number;
  otherMax: number;
  otherSatisfied: number;
  showConnectivity: boolean;
  showBandwidth: boolean;
  uploadRateLimitEnabled: boolean;
  uploadRateLimitMode: WebRTCUploadRateLimitMode;
  uploadRateLimitBytesPerSecond: number;
  forwardRateLimitEnabled: boolean;
  forwardRateLimitMaxForwardsPerPeerWindow: number;
  forwardRateLimitWindowMs: number;
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

export const WEBRTC_RATE_LIMIT_MOBILE_MEDIA = '(max-width: 860px)';
export const DEFAULT_MOBILE_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND = 100 * 1024;
export const DEFAULT_DESKTOP_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND = 1024 * 1024;
export const DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_MAX_FORWARDS_PER_PEER_WINDOW = 64;
export const DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_WINDOW_MS = 1000;

export type WebRTCForwardRateLimit = {
  maxForwardsPerPeerWindow: number;
  windowMs: number;
};

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function resolveAutoWebRTCUploadLimitBytesPerSecond(): number {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia(WEBRTC_RATE_LIMIT_MOBILE_MEDIA).matches) {
      return DEFAULT_MOBILE_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND;
    }
  }

  return DEFAULT_DESKTOP_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND;
}

export function resolveConfiguredWebRTCUploadLimitBytesPerSecond(
  pools: PoolSettings,
): number | null {
  if (!pools.uploadRateLimitEnabled) {
    return null;
  }

  if (pools.uploadRateLimitMode === 'custom') {
    return normalizePositiveInteger(
      pools.uploadRateLimitBytesPerSecond,
      DEFAULT_DESKTOP_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND,
    );
  }

  return resolveAutoWebRTCUploadLimitBytesPerSecond();
}

export function resolveConfiguredWebRTCForwardRateLimit(
  pools: PoolSettings,
): WebRTCForwardRateLimit | undefined {
  if (!pools.forwardRateLimitEnabled) {
    return undefined;
  }

  return {
    maxForwardsPerPeerWindow: normalizePositiveInteger(
      pools.forwardRateLimitMaxForwardsPerPeerWindow,
      DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_MAX_FORWARDS_PER_PEER_WINDOW,
    ),
    windowMs: normalizePositiveInteger(
      pools.forwardRateLimitWindowMs,
      DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_WINDOW_MS,
    ),
  };
}

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  followsMax: 20,
  followsSatisfied: 10,
  otherMax: isTestMode ? 0 : 16,
  otherSatisfied: isTestMode ? 0 : 8,
  showConnectivity: true,
  showBandwidth: false,
  uploadRateLimitEnabled: true,
  uploadRateLimitMode: 'auto',
  uploadRateLimitBytesPerSecond: DEFAULT_DESKTOP_WEBRTC_UPLOAD_LIMIT_BYTES_PER_SECOND,
  forwardRateLimitEnabled: true,
  forwardRateLimitMaxForwardsPerPeerWindow: DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_MAX_FORWARDS_PER_PEER_WINDOW,
  forwardRateLimitWindowMs: DEFAULT_WEBRTC_FORWARD_RATE_LIMIT_WINDOW_MS,
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
