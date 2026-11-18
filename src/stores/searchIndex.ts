/**
 * Search Index Store - Uses SearchIndex from hashtree-index
 *
 * Indexes users by name/npub/nip05 with the "u:" prefix.
 */
import { writable, get } from 'svelte/store';
import { SearchIndex } from '@hashtree/index';
import { cid, toHex, fromHex, type CID } from '@hashtree/core';
import { DexieStore } from '@hashtree/dexie';
import {
  getUserSearchTerms,
  parseStoredUserIndexEntry,
  serializeStoredUserIndexEntry,
  type UserIndexEntry,
  type UserIndexEntryInput,
} from '../lib/search/userIndexEntry';

// Use a fresh root because the old index blocks were stored by the shared worker.
const STORAGE_KEY = 'peopleSearchIndexRoot:v1';

export type { UserIndexEntry, UserIndexEntryInput } from '../lib/search/userIndexEntry';

// Keep index blocks outside the storage used for uploads and peer sharing.
const searchIndex = new SearchIndex(new DexieStore('iris-people-search'), { order: 64 });

// Current index root CID
const indexRoot = writable<CID | null>(null);

// Load persisted index root on startup
function loadIndexRoot(): CID | null {
  try {
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

// Save index root to localStorage (debounced).
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

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
}

// Initialize from localStorage
const initialRoot = loadIndexRoot();
if (initialRoot) {
  indexRoot.set(initialRoot);
}

// Persist on changes
indexRoot.subscribe(saveIndexRoot);

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
