/**
 * Hook to subscribe to a user's trees via RefResolver
 *
 * Svelte port - uses Svelte stores instead of React hooks.
 * The link key storage is framework-agnostic.
 */
import { writable, get, type Readable } from 'svelte/store';
import { getRefResolver } from '../refResolver';
import { toHex, type Hash, type RefResolverListEntry, type TreeVisibility } from '@hashtree/core';
import { nostrStore, type NostrState } from '../nostr';
import Dexie from 'dexie';
import { getAllLocalRoots, onCacheUpdate } from '../treeRootCache';
import { isActiveNostrIdentityRouteScope } from '../drive/profileRoute';

// Dexie database for link keys
class LinkKeysDB extends Dexie {
  linkKeys!: Dexie.Table<{ key: string; linkKey: string }, string>;

  constructor() {
    super('hashtree-link-keys');
    this.version(1).stores({
      linkKeys: 'key', // key = "npub/treeName"
    });
  }
}

const db = new LinkKeysDB();

// In-memory cache for sync access (populated from DB)
let linkKeysCache: Record<string, string> = {};
let cacheLoadPromise: Promise<void> | null = null;

// Listeners for link key updates
const linkKeyListeners: Set<() => void> = new Set();

/**
 * Subscribe to link key updates
 */
export function onLinkKeyUpdate(callback: () => void): () => void {
  linkKeyListeners.add(callback);
  return () => linkKeyListeners.delete(callback);
}

// Load cache from DB
async function loadCache(): Promise<void> {
  if (cacheLoadPromise) return cacheLoadPromise;
  cacheLoadPromise = (async () => {
    try {
      const all = await db.linkKeys.toArray();
      linkKeysCache = Object.fromEntries(all.map(e => [e.key, e.linkKey]));
    } catch {
      // Ignore errors
    }
  })();
  return cacheLoadPromise;
}

// Initialize cache on module load
loadCache();

/**
 * Get stored link keys (sync, from cache)
 */
export function getStoredLinkKeys(): Record<string, string> {
  return linkKeysCache;
}

/**
 * Wait for cache to be loaded
 */
export async function waitForLinkKeysCache(): Promise<void> {
  await loadCache();
}

/**
 * Store a link key for a link-visible tree
 */
export async function storeLinkKey(npub: string, treeName: string, linkKey: string): Promise<void> {
  const key = `${npub}/${treeName}`;
  linkKeysCache[key] = linkKey;
  await db.linkKeys.put({ key, linkKey });
  // Notify listeners that a link key was updated
  linkKeyListeners.forEach(fn => fn());
}

/**
 * Get a stored link key for a tree
 */
export function getLinkKey(npub: string, treeName: string): string | null {
  return linkKeysCache[`${npub}/${treeName}`] ?? null;
}

/**
 * Decrypt and store link key from selfEncryptedLinkKey
 * Used to recover link keys for own link-visible trees
 */
export async function recoverLinkKeyFromSelfEncrypted(
  npub: string,
  treeName: string,
  selfEncryptedLinkKey: string
): Promise<string | null> {
  // Import decrypt lazily to avoid circular dependencies
  const { decrypt } = await import('../nostr');
  const state = nostrStore.getState();

  if (!state.pubkey) return null;

  try {
    const linkKey = await decrypt(state.pubkey, selfEncryptedLinkKey);
    if (linkKey && linkKey.length === 64) {
      await storeLinkKey(npub, treeName, linkKey);
      return linkKey;
    }
  } catch (e) {
    console.debug('Could not decrypt selfEncryptedLinkKey:', e);
  }
  return null;
}

export interface TreeEntry {
  key: string;      // "npub1.../treename"
  name: string;     // Just the tree name
  hash: Hash;       // Current root hash
  hashHex: string;  // Hex string of hash
  /** All l-tags attached to the tree root event */
  labels?: string[];
  /** @deprecated Use visibility instead */
  encryptionKey?: Hash; // Encryption key (if encrypted, public)
  /** Tree visibility: public, link-visible, or private. Undefined if not yet resolved from Nostr. */
  visibility: TreeVisibility | undefined;
  /** Encrypted key for link-visible trees */
  encryptedKey?: string;
  /** Key ID for link-visible trees */
  keyId?: string;
  /** Self-encrypted key for private/link-visible trees */
  selfEncryptedKey?: string;
  /** Self-encrypted link key for link-visible trees (allows owner to recover link key) */
  selfEncryptedLinkKey?: string;
  /** Link key for link-visible trees (only for own trees, from local storage or decrypted) */
  linkKey?: string;
  /** Unix timestamp when the tree was created/last updated */
  createdAt?: number;
}

/**
 * Create a Svelte store that subscribes to trees for an npub
 * Returns a Readable store with live-updating list of trees
 */
export function createTreesStore(npub: string | null): Readable<TreeEntry[]> {
  const store = writable<TreeEntry[]>([]);

  if (!npub) {
    return { subscribe: store.subscribe };
  }

  const resolver = getRefResolver();
  if (!resolver.list) {
    return { subscribe: store.subscribe };
  }

  // Get current user's npub for comparison
  const nostrState = nostrStore.getState();
  const userNpub = nostrState.npub;
  const isOwnTrees = npub === userNpub || isActiveNostrIdentityRouteScope(npub, nostrState);

  // In-memory cache for decrypted link keys
  const decryptedLinkKeys: Record<string, string> = {};
  const pendingDecryptions = new Set<string>();

  const mergeWithLocalRoots = (entries: RefResolverListEntry[] | null) => {
    const merged = new Map<string, RefResolverListEntry>();

    for (const entry of entries ?? []) {
      merged.set(entry.key, entry);
    }

    if (isOwnTrees) {
      for (const [key, localRoot] of getAllLocalRoots().entries()) {
        if (!key.startsWith(`${npub}/`)) continue;
        const existing = merged.get(key);
        if (existing) {
          merged.set(key, {
            ...existing,
            cid: {
              ...existing.cid,
              hash: localRoot.hash,
              key: localRoot.key,
            },
            visibility: localRoot.visibility ?? existing.visibility,
            labels: localRoot.labels ?? existing.labels,
          });
          continue;
        }

        merged.set(key, {
          key,
          cid: { hash: localRoot.hash, key: localRoot.key },
          visibility: localRoot.visibility,
          labels: localRoot.labels,
          encryptedKey: undefined,
          keyId: undefined,
          selfEncryptedKey: undefined,
          selfEncryptedLinkKey: undefined,
          createdAt: undefined,
        });
      }
    }

    return Array.from(merged.values());
  };

  // Helper to update store with current decrypted keys
  const updateStore = (entries: RefResolverListEntry[] | null) => {
    if (!entries) return;
    const mapped = entries.map((e) => {
      const slashIdx = e.key.indexOf('/');
      const name = slashIdx >= 0 ? e.key.slice(slashIdx + 1) : '';
      const visibility = e.visibility;
      const linkKey = isOwnTrees ? decryptedLinkKeys[`${npub}/${name}`] : undefined;

      return {
        key: e.key,
        name,
        hash: e.cid.hash,
        hashHex: toHex(e.cid.hash),
        labels: e.labels,
        encryptionKey: e.cid.key,
        visibility,
        encryptedKey: e.encryptedKey,
        keyId: e.keyId,
        selfEncryptedKey: e.selfEncryptedKey,
        selfEncryptedLinkKey: e.selfEncryptedLinkKey,
        linkKey,
        createdAt: e.createdAt,
      };
    });
    store.set(mapped);
  };

  // Keep reference to last entries for re-rendering after decryption
  let lastEntries: RefResolverListEntry[] | null = null;

  const handleEntries = (entries: RefResolverListEntry[] | null) => {
    lastEntries = mergeWithLocalRoots(entries);
    updateStore(lastEntries);

    // Decrypt link keys for own link-visible trees in background
    if (isOwnTrees) {
      for (const e of lastEntries) {
        if (e.visibility === 'link-visible' && e.selfEncryptedLinkKey) {
          const slashIdx = e.key.indexOf('/');
          const name = slashIdx >= 0 ? e.key.slice(slashIdx + 1) : '';
          const cacheKey = `${npub}/${name}`;

          // Skip if already decrypted or pending
          if (decryptedLinkKeys[cacheKey] || pendingDecryptions.has(cacheKey)) continue;

          pendingDecryptions.add(cacheKey);
          recoverLinkKeyFromSelfEncrypted(npub, name, e.selfEncryptedLinkKey).then(linkKey => {
            pendingDecryptions.delete(cacheKey);
            if (linkKey) {
              decryptedLinkKeys[cacheKey] = linkKey;
              updateStore(lastEntries); // Re-render with decrypted key
            }
          });
        }
      }
    }
  };

  if (isOwnTrees) {
    handleEntries([]);
  }

  // Subscribe to resolver list
  let unsubscribe = resolver.list!(npub, handleEntries);
  let lastConnectedRelays = nostrStore.getState().connectedRelays;
  const relayUnsubscribe = nostrStore.subscribe((state: NostrState) => {
    if (state.connectedRelays > 0 && lastConnectedRelays === 0) {
      unsubscribe?.();
      unsubscribe = resolver.list!(npub, handleEntries);
    }
    lastConnectedRelays = state.connectedRelays;
  });
  const cacheUnsubscribe = isOwnTrees
    ? onCacheUpdate((ownerNpub) => {
        if (ownerNpub === npub) {
          handleEntries(lastEntries);
        }
      })
    : null;

  return {
    subscribe: (fn: (value: TreeEntry[]) => void) => {
      const unsub = store.subscribe(fn);
      return () => {
        unsub();
        unsubscribe?.();
        relayUnsubscribe?.();
        cacheUnsubscribe?.();
      };
    }
  };
}

// For backward compatibility with React-style usage in non-component code
export function trees(npub: string | null): TreeEntry[] {
  const store = createTreesStore(npub);
  return get(store);
}
