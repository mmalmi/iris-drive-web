/**
 * Settings store with Dexie persistence (Svelte version)
 */
import { writable, get } from 'svelte/store';
import Dexie, { type Table } from 'dexie';
import {
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_IMGPROXY_SETTINGS,
  DEFAULT_NETWORK_SETTINGS,
  DEFAULT_POOL_SETTINGS,
  DEFAULT_STORAGE_SETTINGS,
  DEFAULT_UPLOAD_SETTINGS,
  applyProductionNetworkFallback,
  isTestMode,
  normalizePositiveInteger,
} from './settingsDefaults';
import type {
  BlossomServerConfig,
  EditorSettings,
  ImgproxySettings,
  NetworkSettings,
  PoolSettings,
  StorageSettings,
  UploadSettings,
} from './settingsDefaults';

export * from './settingsDefaults';

// Dexie database for settings persistence
class SettingsDB extends Dexie {
  settings!: Table<{ key: string; value: unknown }>;

  constructor() {
    super('hashtree-settings');
    this.version(1).stores({
      settings: '&key',
    });
  }
}

const db = new SettingsDB();

export interface SettingsState {
  // Legacy settings (kept for compatibility)
  appearance: Record<string, unknown>;
  content: Record<string, unknown>;
  notifications: Record<string, unknown>;
  desktop: Record<string, unknown>;
  debug: Record<string, unknown>;
  legal: Record<string, unknown>;

  // Imgproxy settings
  imgproxy: ImgproxySettings;

  // Pool settings
  pools: PoolSettings;
  poolsLoaded: boolean;

  // Upload settings
  upload: UploadSettings;

  // Editor settings
  editor: EditorSettings;

  // Network settings
  network: NetworkSettings;
  networkLoaded: boolean;

  // Storage settings
  storage: StorageSettings;
  storageLoaded: boolean;

  // Blocked peers (pubkeys)
  blockedPeers: string[];
}

function createSettingsStore() {
  const { subscribe, update } = writable<SettingsState>({
    // Legacy settings
    appearance: {},
    content: {},
    notifications: {},
    desktop: {},
    debug: {},
    legal: {},

    // Imgproxy settings
    imgproxy: DEFAULT_IMGPROXY_SETTINGS,

    // Pool settings
    pools: DEFAULT_POOL_SETTINGS,
    poolsLoaded: false,

    // Upload settings
    upload: DEFAULT_UPLOAD_SETTINGS,

    // Editor settings
    editor: DEFAULT_EDITOR_SETTINGS,

    // Network settings
    network: DEFAULT_NETWORK_SETTINGS,
    networkLoaded: false,

    // Storage settings
    storage: DEFAULT_STORAGE_SETTINGS,
    storageLoaded: false,

    // Blocked peers
    blockedPeers: [],
  });

  return {
    subscribe,

    setPoolSettings: (pools: Partial<PoolSettings>) => {
      update(state => {
        const updated: PoolSettings = {
          ...state.pools,
          ...pools,
          uploadRateLimitMode: pools.uploadRateLimitMode === 'custom'
            ? 'custom'
            : (pools.uploadRateLimitMode === 'auto' ? 'auto' : state.pools.uploadRateLimitMode),
          uploadRateLimitBytesPerSecond: normalizePositiveInteger(
            pools.uploadRateLimitBytesPerSecond ?? state.pools.uploadRateLimitBytesPerSecond,
            DEFAULT_POOL_SETTINGS.uploadRateLimitBytesPerSecond,
          ),
          forwardRateLimitMaxForwardsPerPeerWindow: normalizePositiveInteger(
            pools.forwardRateLimitMaxForwardsPerPeerWindow ?? state.pools.forwardRateLimitMaxForwardsPerPeerWindow,
            DEFAULT_POOL_SETTINGS.forwardRateLimitMaxForwardsPerPeerWindow,
          ),
          forwardRateLimitWindowMs: normalizePositiveInteger(
            pools.forwardRateLimitWindowMs ?? state.pools.forwardRateLimitWindowMs,
            DEFAULT_POOL_SETTINGS.forwardRateLimitWindowMs,
          ),
        };
        // Persist to Dexie
        db.settings.put({ key: 'pools', value: updated }).catch(console.error);
        return { ...state, pools: updated };
      });
    },

    resetPoolSettings: () => {
      update(state => {
        db.settings.put({ key: 'pools', value: DEFAULT_POOL_SETTINGS }).catch(console.error);
        return { ...state, pools: DEFAULT_POOL_SETTINGS };
      });
    },

    setUploadSettings: (upload: Partial<UploadSettings>) => {
      update(state => {
        const updated = { ...state.upload, ...upload };
        db.settings.put({ key: 'upload', value: updated }).catch(console.error);
        return { ...state, upload: updated };
      });
    },

    setEditorSettings: (editor: Partial<EditorSettings>) => {
      update(state => {
        const updated = { ...state.editor, ...editor };
        db.settings.put({ key: 'editor', value: updated }).catch(console.error);
        return { ...state, editor: updated };
      });
    },

    setImgproxySettings: (imgproxy: Partial<ImgproxySettings>) => {
      update(state => {
        const updated = { ...state.imgproxy, ...imgproxy };
        db.settings.put({ key: 'imgproxy', value: updated }).catch(console.error);
        return { ...state, imgproxy: updated };
      });
    },

    resetImgproxySettings: () => {
      update(state => {
        db.settings.put({ key: 'imgproxy', value: DEFAULT_IMGPROXY_SETTINGS }).catch(console.error);
        return { ...state, imgproxy: DEFAULT_IMGPROXY_SETTINGS };
      });
    },

    setNetworkSettings: (network: Partial<NetworkSettings>) => {
      update(state => {
        const updated = { ...state.network, ...network };
        db.settings.put({ key: 'network', value: updated }).catch(console.error);
        return { ...state, network: updated };
      });
    },

    resetNetworkSettings: () => {
      update(state => {
        db.settings.put({ key: 'network', value: DEFAULT_NETWORK_SETTINGS }).catch(console.error);
        return { ...state, network: DEFAULT_NETWORK_SETTINGS };
      });
    },

    setStorageSettings: (storage: Partial<StorageSettings>) => {
      update(state => {
        const updated = { ...state.storage, ...storage };
        db.settings.put({ key: 'storage', value: updated }).catch(console.error);
        return { ...state, storage: updated };
      });
    },

    resetStorageSettings: () => {
      update(state => {
        db.settings.put({ key: 'storage', value: DEFAULT_STORAGE_SETTINGS }).catch(console.error);
        return { ...state, storage: DEFAULT_STORAGE_SETTINGS };
      });
    },

    blockPeer: (pubkey: string) => {
      update(state => {
        if (state.blockedPeers.includes(pubkey)) return state;
        const updated = [...state.blockedPeers, pubkey];
        db.settings.put({ key: 'blockedPeers', value: updated }).catch(console.error);
        return { ...state, blockedPeers: updated };
      });
    },

    unblockPeer: (pubkey: string) => {
      update(state => {
        const updated = state.blockedPeers.filter(p => p !== pubkey);
        db.settings.put({ key: 'blockedPeers', value: updated }).catch(console.error);
        return { ...state, blockedPeers: updated };
      });
    },

    isPeerBlocked: (pubkey: string): boolean => {
      return get(settingsStore).blockedPeers.includes(pubkey);
    },

    // Get current state synchronously
    getState: (): SettingsState => get(settingsStore),

    // Set state directly
    setState: (newState: Partial<SettingsState>) => {
      update(state => ({ ...state, ...newState }));
    },
  };
}

export const settingsStore = createSettingsStore();

// Legacy compatibility alias
export const useSettingsStore = settingsStore;

// Load settings from Dexie on startup
async function loadSettings() {
  try {
    const [poolsRow, uploadRow, editorRow, networkRow, imgproxyRow, storageRow, blockedPeersRow] = await Promise.all([
      db.settings.get('pools'),
      db.settings.get('upload'),
      db.settings.get('editor'),
      db.settings.get('network'),
      db.settings.get('imgproxy'),
      db.settings.get('storage'),
      db.settings.get('blockedPeers'),
    ]);

    const updates: Partial<SettingsState> = { poolsLoaded: true, networkLoaded: true, storageLoaded: true };

    if (poolsRow?.value) {
      const pools = poolsRow.value as PoolSettings;
      updates.pools = {
        followsMax: pools.followsMax ?? DEFAULT_POOL_SETTINGS.followsMax,
        followsSatisfied: pools.followsSatisfied ?? DEFAULT_POOL_SETTINGS.followsSatisfied,
        otherMax: pools.otherMax ?? DEFAULT_POOL_SETTINGS.otherMax,
        otherSatisfied: pools.otherSatisfied ?? DEFAULT_POOL_SETTINGS.otherSatisfied,
        showConnectivity: pools.showConnectivity ?? DEFAULT_POOL_SETTINGS.showConnectivity,
        showBandwidth: pools.showBandwidth ?? DEFAULT_POOL_SETTINGS.showBandwidth,
        uploadRateLimitEnabled: pools.uploadRateLimitEnabled ?? DEFAULT_POOL_SETTINGS.uploadRateLimitEnabled,
        uploadRateLimitMode: pools.uploadRateLimitMode === 'custom' ? 'custom' : DEFAULT_POOL_SETTINGS.uploadRateLimitMode,
        uploadRateLimitBytesPerSecond: normalizePositiveInteger(
          pools.uploadRateLimitBytesPerSecond,
          DEFAULT_POOL_SETTINGS.uploadRateLimitBytesPerSecond,
        ),
        forwardRateLimitEnabled: pools.forwardRateLimitEnabled ?? DEFAULT_POOL_SETTINGS.forwardRateLimitEnabled,
        forwardRateLimitMaxForwardsPerPeerWindow: normalizePositiveInteger(
          pools.forwardRateLimitMaxForwardsPerPeerWindow,
          DEFAULT_POOL_SETTINGS.forwardRateLimitMaxForwardsPerPeerWindow,
        ),
        forwardRateLimitWindowMs: normalizePositiveInteger(
          pools.forwardRateLimitWindowMs,
          DEFAULT_POOL_SETTINGS.forwardRateLimitWindowMs,
        ),
      };
    }

    if (uploadRow?.value) {
      const upload = uploadRow.value as UploadSettings;
      updates.upload = {
        gitignoreBehavior: upload.gitignoreBehavior ?? DEFAULT_UPLOAD_SETTINGS.gitignoreBehavior,
      };
    }

    if (editorRow?.value) {
      const editor = editorRow.value as EditorSettings;
      updates.editor = {
        autoSave: editor.autoSave ?? DEFAULT_EDITOR_SETTINGS.autoSave,
      };
    }

    if (networkRow?.value) {
      const network = networkRow.value as NetworkSettings;
      // Handle backwards compatibility: convert old string[] format to BlossomServerConfig[]
      let blossomServers = DEFAULT_NETWORK_SETTINGS.blossomServers;
      if (network.blossomServers && Array.isArray(network.blossomServers)) {
        blossomServers = network.blossomServers.map(s =>
          typeof s === 'string' ? { url: s, read: true, write: false } : { ...s, read: s.read ?? true }
        );
      }
      const nextNetwork = {
        relays: network.relays ?? DEFAULT_NETWORK_SETTINGS.relays,
        blossomServers,
        negentropyEnabled: network.negentropyEnabled ?? DEFAULT_NETWORK_SETTINGS.negentropyEnabled,
      };
      updates.network = isTestMode ? nextNetwork : applyProductionNetworkFallback(nextNetwork);
    } else if (isTestMode) {
      updates.network = DEFAULT_NETWORK_SETTINGS;
    }

    if (imgproxyRow?.value) {
      const imgproxy = imgproxyRow.value as ImgproxySettings;
      updates.imgproxy = {
        enabled: imgproxy.enabled ?? DEFAULT_IMGPROXY_SETTINGS.enabled,
        url: imgproxy.url ?? DEFAULT_IMGPROXY_SETTINGS.url,
        key: imgproxy.key ?? DEFAULT_IMGPROXY_SETTINGS.key,
        salt: imgproxy.salt ?? DEFAULT_IMGPROXY_SETTINGS.salt,
      };
    }

    if (storageRow?.value) {
      const storage = storageRow.value as StorageSettings;
      updates.storage = {
        maxBytes: storage.maxBytes ?? DEFAULT_STORAGE_SETTINGS.maxBytes,
      };
    }

    if (blockedPeersRow?.value && Array.isArray(blockedPeersRow.value)) {
      updates.blockedPeers = blockedPeersRow.value as string[];
    }

    settingsStore.setState(updates);
  } catch (err) {
    console.error('[settings] error loading:', err);
    settingsStore.setState({ poolsLoaded: true, networkLoaded: true, storageLoaded: true });
  }
}

// Promise that resolves when settings are loaded
let settingsLoadedResolve: (() => void) | null = null;
const settingsLoadedPromise = new Promise<void>((resolve) => {
  settingsLoadedResolve = resolve;
});

// Initialize on module load
loadSettings().then(() => {
  settingsLoadedResolve?.();
});

/**
 * Wait for settings to be loaded from IndexedDB.
 * Use this before initializing components that need correct settings from the start.
 */
export function waitForSettingsLoaded(): Promise<void> {
  return settingsLoadedPromise;
}

// Expose for e2e tests to configure settings without module duplication issues
// Track all store instances to handle Vite module duplication
if (typeof window !== 'undefined') {
  type SettingsStoreInstance = { setNetworkSettings: (settings: Partial<NetworkSettings>) => void };
  const win = window as unknown as {
    __settingsStoreInstances?: SettingsStoreInstance[];
    __configureBlossomServers?: (servers: BlossomServerConfig[]) => void;
  };

  // Register this store instance
  if (!win.__settingsStoreInstances) {
    win.__settingsStoreInstances = [];
  }
  win.__settingsStoreInstances.push(settingsStore);

  // Update all instances when called
  win.__configureBlossomServers = (servers: BlossomServerConfig[]) => {
    for (const store of win.__settingsStoreInstances || []) {
      store.setNetworkSettings({ blossomServers: servers });
    }
  };
}
