import { DEFAULT_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';

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
