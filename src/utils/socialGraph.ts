/**
 * Social Graph integration using Unified Worker
 * Provides follow distance calculations and trust indicators
 * Heavy operations happen in worker, main thread keeps sync cache for UI
 */
import { writable, get } from 'svelte/store';
import { getWorkerAdapter } from '../workerAdapter';
import { nostrStore } from '../nostr/store';
import { DEFAULT_BOOTSTRAP_PUBKEY } from './constants';
import { LRUCache } from './lruCache';

// Default root pubkey (used when not logged in)
const DEFAULT_SOCIAL_GRAPH_ROOT = DEFAULT_BOOTSTRAP_PUBKEY;

// ============================================================================
// Sync Caches (for immediate UI access) - Using LRU eviction
// ============================================================================

// Cache size limits to prevent memory bloat
const CACHE_MAX_SIZE = 1000;
const FOLLOWING_CACHE_MAX_SIZE = 5000; // Larger since it's checked frequently

type GraphAdapter = NonNullable<ReturnType<typeof getWorkerAdapter>>;
let graphGeneration = 0;
let cacheAdapter: GraphAdapter | null = null;
let cachePubkey: string | null = null;
const clearGraphCaches: Array<() => void> = [];

function graphContext() {
  const adapter = getWorkerAdapter();
  const pubkey = nostrStore.getState().pubkey;
  if (adapter !== cacheAdapter || pubkey !== cachePubkey) {
    cacheAdapter = adapter;
    cachePubkey = pubkey;
    graphGeneration++;
    for (const clear of clearGraphCaches) clear();
  }
  return { adapter, pubkey, generation: graphGeneration };
}

function sameMembers(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

/** Keep old values during refresh, but never accept an old graph/account reply. */
function createGraphCache<T>(capacity: number, equal: (a: T, b: T) => boolean = Object.is) {
  const values = new LRUCache<string, { value: T; generation: number }>(capacity);
  const pending = new Map<string, { generation: number }>();
  clearGraphCaches.push(() => { values.clear(); pending.clear(); });
  return {
    invalidate(key: string) {
      const cached = values.get(key);
      if (cached) cached.generation = -1;
    },
    read(key: string, fallback: T, query: (adapter: GraphAdapter) => Promise<T>, refresh = true): T {
      const { adapter, pubkey, generation } = graphContext();
      const cached = values.get(key);
      if (cached && (!refresh || cached.generation === generation)) return cached.value;
      if (adapter && pending.get(key)?.generation !== generation) {
        const request = { generation };
        pending.set(key, request);
        void query(adapter).then(value => {
          if (adapter !== getWorkerAdapter() || pubkey !== nostrStore.getState().pubkey
            || generation !== graphGeneration) return;
          const previous = values.get(key);
          values.set(key, { value, generation });
          if (!previous || !equal(previous.value, value)) socialGraphStore.incrementVersion();
        }).catch(() => {}).finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      }
      return cached ? cached.value : fallback;
    },
  };
}

const followDistanceCache = createGraphCache<number>(CACHE_MAX_SIZE);
const isFollowingCache = createGraphCache<boolean>(FOLLOWING_CACHE_MAX_SIZE);
const followsCache = createGraphCache<Set<string>>(CACHE_MAX_SIZE, sameMembers);
const followersCache = createGraphCache<Set<string>>(CACHE_MAX_SIZE, sameMembers);
const friendsFollowingCache = createGraphCache<Set<string>>(CACHE_MAX_SIZE, sameMembers);

// Track pending fetches to avoid duplicate requests and flickering
const pendingProfileFollows = new Set<string>();
const pendingProfileFollowers = new Set<string>();

// ============================================================================
// Svelte Store
// ============================================================================

interface SocialGraphState {
  version: number;
}

function createSocialGraphStore() {
  const { subscribe, update } = writable<SocialGraphState>({
    version: 0,
  });

  // Debounce version increments to prevent cascade re-renders
  let pendingIncrement = false;
  let incrementTimeout: ReturnType<typeof setTimeout> | null = null;

  const flushIncrement = () => {
    if (pendingIncrement) {
      update(state => ({ ...state, version: state.version + 1 }));
      pendingIncrement = false;
    }
    incrementTimeout = null;
  };

  return {
    subscribe,
    graphChanged: () => {
      graphGeneration++;
      // UI notifications and worker freshness are separate monotonic clocks.
      update(state => ({ ...state, version: state.version + 1 }));
    },
    incrementVersion: () => {
      // Debounce: batch multiple increments into one update after 100ms idle
      pendingIncrement = true;
      if (incrementTimeout) clearTimeout(incrementTimeout);
      incrementTimeout = setTimeout(flushIncrement, 100);
    },
    getState: (): SocialGraphState => get(socialGraphStore),
  };
}

export const socialGraphStore = createSocialGraphStore();

// ============================================================================
// Version callback setup (called after worker ready)
// ============================================================================

export function setupVersionCallback() {
  const adapter = getWorkerAdapter();
  if (adapter) {
    graphContext();
    adapter.onSocialGraphVersion(() => {
      if (adapter !== getWorkerAdapter()) return;
      graphContext();
      socialGraphStore.graphChanged();
    });
    flushPendingProfileFetches();
  }
}

// ============================================================================
// Public API (sync where possible, async fallback)
// ============================================================================

/**
 * Get follow distance (sync, returns cached or 1000)
 */
export function getFollowDistance(pubkey: string | null | undefined): number {
  if (!pubkey) return 1000;
  return followDistanceCache.read(pubkey, 1000, adapter => adapter.getFollowDistance(pubkey));
}

/**
 * Check if one user follows another (sync)
 */
export function isFollowing(
  follower: string | null | undefined,
  followedUser: string | null | undefined
): boolean {
  if (!follower || !followedUser) return false;

  const key = `${follower}:${followedUser}`;
  return isFollowingCache.read(key, false, adapter => adapter.isFollowing(follower, followedUser));
}

/**
 * Get users followed by a user (sync)
 */
export function getFollows(pubkey: string | null | undefined): Set<string> {
  if (!pubkey) return new Set();
  return followsCache.read(pubkey, new Set(), async adapter => new Set(await adapter.getFollows(pubkey)));
}

// Track pubkeys we're actively watching (profile views)
const watchedFollowersPubkeys = new Set<string>();

/**
 * Get followers of a user (sync)
 * Returns cached value immediately, triggers background fetch if not cached
 * or if version changed since last fetch for watched pubkeys.
 */
export function getFollowers(pubkey: string | null | undefined): Set<string> {
  if (!pubkey) return new Set();
  return followersCache.read(pubkey, new Set(), async adapter => new Set(await adapter.getFollowers(pubkey)),
    watchedFollowersPubkeys.has(pubkey));
}

/**
 * Get users who follow a given pubkey (from friends)
 */
export function getFollowedByFriends(pubkey: string | null | undefined): Set<string> {
  if (!pubkey) return new Set();
  return friendsFollowingCache.read(pubkey, new Set(), async adapter => new Set(await adapter.getFollowedByFriends(pubkey)));
}

/**
 * Check if a user follows the current logged-in user
 */
export function getFollowsMe(pubkey: string | null | undefined): boolean {
  const myPubkey = nostrStore.getState().pubkey;
  if (!pubkey || !myPubkey) return false;
  return isFollowing(pubkey, myPubkey);
}

/**
 * Fetch a user's follow list when visiting their profile.
 * Only fetches if we don't already have their follow list.
 * Call this when a ProfileView mounts.
 */
export function fetchUserFollows(pubkey: string | null | undefined): void {
  if (!pubkey) return;
  const adapter = getWorkerAdapter();
  if (adapter) {
    adapter.fetchUserFollows(pubkey);
  } else {
    pendingProfileFollows.add(pubkey);
  }
}

/**
 * Fetch followers of a user when visiting their profile.
 * Subscribes to kind:3 events with #p tag mentioning this user.
 * Call this when a ProfileView mounts.
 */
export function fetchUserFollowers(pubkey: string | null | undefined): void {
  if (!pubkey) return;
  const adapter = getWorkerAdapter();
  if (adapter) {
    // Mark as watched so we re-fetch on version changes
    watchedFollowersPubkeys.add(pubkey);
    // Invalidate version tracking so next getFollowers call fetches fresh
    followersCache.invalidate(pubkey);
    adapter.fetchUserFollowers(pubkey);
  } else {
    // Track intent to fetch once worker is ready.
    watchedFollowersPubkeys.add(pubkey);
    followersCache.invalidate(pubkey);
    pendingProfileFollowers.add(pubkey);
  }
}

function flushPendingProfileFetches(): void {
  if (pendingProfileFollows.size === 0 && pendingProfileFollowers.size === 0) return;
  const adapter = getWorkerAdapter();
  if (!adapter) return;
  for (const pubkey of pendingProfileFollows) {
    adapter.fetchUserFollows(pubkey);
  }
  pendingProfileFollows.clear();
  for (const pubkey of pendingProfileFollowers) {
    adapter.fetchUserFollowers(pubkey);
  }
  pendingProfileFollowers.clear();
}

/**
 * Stop watching followers for a pubkey (call when leaving profile view)
 */
export function unwatchUserFollowers(pubkey: string | null | undefined): void {
  if (!pubkey) return;
  watchedFollowersPubkeys.delete(pubkey);
}

// Legacy alias
export const follows = getFollows;

// Mock SocialGraph interface for backwards compatibility (e2e tests)
export function getSocialGraph(): { getRoot: () => string } | null {
  return {
    getRoot: () => DEFAULT_SOCIAL_GRAPH_ROOT,
  };
}

// Worker handles SocialGraph init and kind:3 subscriptions internally
// App waits for restoreSession() before mounting, so worker is ready
