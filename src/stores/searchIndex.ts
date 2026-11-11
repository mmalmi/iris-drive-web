/**
 * Search Index Store - Uses SearchIndex from hashtree-index
 *
 * Indexes users by name/npub/nip05 with the "u:" prefix.
 */
import { writable, get } from 'svelte/store';
import { SearchIndex } from '@hashtree/index';
import { cid, toHex, fromHex, type CID } from '@hashtree/core';
import { localStore } from '../store';
import {
  getUserSearchTerms,
  parseStoredUserIndexEntry,
  serializeStoredUserIndexEntry,
  type UserIndexEntry,
  type UserIndexEntryInput,
} from '../lib/search/userIndexEntry';

const STORAGE_KEY = 'searchIndexRoot';
const INDEX_VERSION_KEY = 'searchIndexVersion';
const CURRENT_INDEX_VERSION = 2; // Increment when format changes

export type { UserIndexEntry, UserIndexEntryInput } from '../lib/search/userIndexEntry';

// SearchIndex instance (uses shared localStore)
const searchIndex = new SearchIndex(localStore, { order: 64 });

// Current index root CID
const indexRoot = writable<CID | null>(null);

// Load persisted index root on startup
function loadIndexRoot(): CID | null {
  try {
    // Check index version - clear if outdated
    const storedVersion = localStorage.getItem(INDEX_VERSION_KEY);
    const version = storedVersion ? parseInt(storedVersion, 10) : 0;
    if (version < CURRENT_INDEX_VERSION) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(INDEX_VERSION_KEY, CURRENT_INDEX_VERSION.toString());
      return null;
    }

    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (parsed && parsed.hash && parsed.key) {
      return cid(fromHex(parsed.hash), fromHex(parsed.key));
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

// Tree name for search index on Nostr
const SEARCH_INDEX_TREE = '_search';

// Save index root to localStorage and publish to Nostr (debounced)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let publishTimeout: ReturnType<typeof setTimeout> | null = null;

function saveIndexRoot(root: CID | null): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      if (root) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          hash: toHex(root.hash),
          key: root.key ? toHex(root.key) : null,
        }));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }, 1000);

  // Also schedule publish to Nostr
  schedulePublish(root);
}

function schedulePublish(root: CID | null): void {
  if (publishTimeout) clearTimeout(publishTimeout);
  if (!root) return;

  publishTimeout = setTimeout(async () => {
    try {
      const { nostrStore } = await import('../nostr/store');
      const { getRefResolver } = await import('../refResolver');

      const state = nostrStore.getState();
      if (!state.npub || !state.isLoggedIn) return;

      const resolver = getRefResolver();
      await resolver.publish?.(
        `${state.npub}/${SEARCH_INDEX_TREE}`,
        root,
        { visibility: 'public' }
      );
    } catch (e) {
      console.error('Failed to publish search index:', e);
    }
  }, 3000);
}

// Initialize from localStorage
const initialRoot = loadIndexRoot();
if (initialRoot) {
  indexRoot.set(initialRoot);
}

// Persist on changes
indexRoot.subscribe(saveIndexRoot);

// Re-export parseKeywords from SearchIndex for components that need it
export function parseKeywords(text: string): string[] {
  return searchIndex.parseKeywords(text);
}

// ============ User Index ============

const pendingUserOps: UserIndexEntryInput[] = [];
let userFlushTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Index multiple users at once (more efficient)
 */
export async function indexUsers(entries: UserIndexEntryInput[]): Promise<void> {
  pendingUserOps.push(...entries);

  if (userFlushTimeout) clearTimeout(userFlushTimeout);
  userFlushTimeout = setTimeout(flushPendingUserOps, 100);
}

async function flushPendingUserOps(): Promise<void> {
  if (pendingUserOps.length === 0) return;

  const ops = [...pendingUserOps];
  pendingUserOps.length = 0;
  userFlushTimeout = null;

  let root = get(indexRoot);

  for (const entry of ops) {
    const terms = getUserSearchTerms(entry);
    const value = serializeStoredUserIndexEntry(entry);

    try {
      root = await searchIndex.index(root, 'u:', terms, entry.pubkey, value);
    } catch (e) {
      console.error('Failed to index user:', entry.pubkey, e);
    }
  }

  indexRoot.set(root);
}

/**
 * Search users by name, nip05, or npub prefix
 */
export async function searchUsers(query: string, limit = 10): Promise<UserIndexEntry[]> {
  const root = get(indexRoot);
  if (!root) return [];

  const trimmed = query.trim().toLowerCase();
  if (trimmed.length < 1) return [];

  // For user search, we do a simple prefix search on the raw query
  // (not parsed into keywords) to support npub prefix matching
  const results = await searchIndex.search(root, 'u:', trimmed, { limit });

  return results
    .map(result => parseStoredUserIndexEntry(result.value))
    .filter((entry): entry is UserIndexEntry => !!entry);
}
