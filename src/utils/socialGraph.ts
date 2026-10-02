/**
 * Social Graph integration using Unified Worker
 * Provides follow distance calculations and trust indicators
 * Heavy operations happen in worker, main thread keeps sync cache for UI
 */
import { writable, get } from 'svelte/store';
import { getWorkerAdapter } from '../workerAdapter';
import { nostrStore, type NostrState } from '../nostr/store';
import { DEFAULT_BOOTSTRAP_PUBKEY } from './constants';
import { LRUCache } from './lruCache';

// Default root pubkey (used when not logged in)
const DEFAULT_SOCIAL_GRAPH_ROOT = DEFAULT_BOOTSTRAP_PUBKEY;
let currentRoot = DEFAULT_SOCIAL_GRAPH_ROOT;

// Debug logging
const DEBUG = false;
const log = (...args: unknown[]) => DEBUG && console.log('[socialGraph]', ...args);

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
const graphSizeCache = createGraphCache<number>(1);

// Track pending fetches to avoid duplicate requests and flickering
const pendingProfileFollows = new Set<string>();
const pendingProfileFollowers = new Set<string>();

// ============================================================================
// Svelte Store
// ============================================================================

interface SocialGraphState {
  version: number;
  isRecrawling: boolean;
}

function createSocialGraphStore() {
  const { subscribe, update } = writable<SocialGraphState>({
    version: 0,
    isRecrawling: false,
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
    setIsRecrawling: (value: boolean) => {
      update(state => ({ ...state, isRecrawling: value }));
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

/**
 * Get the graph size
 */
export function getGraphSize(): number {
  return graphSizeCache.read('size', 0, adapter => adapter.getSocialGraphSize());
}

/**
 * Get users at a specific follow distance
 */
export function getUsersByFollowDistance(_distance: number): Set<string> {
  // This is rarely used in hot paths, return empty and let caller handle async if needed
  return new Set();
}

// Legacy aliases
export const followDistance = getFollowDistance;
export const followedByFriends = getFollowedByFriends;
export const follows = getFollows;

// Mock SocialGraph interface for backwards compatibility (e2e tests)
export function getSocialGraph(): { getRoot: () => string } | null {
  return {
    getRoot: () => currentRoot,
  };
}

// ============================================================================
// Subscription Management
// ============================================================================

export async function fetchFollowList(publicKey: string): Promise<void> {
  log('fetching own follow list for', publicKey);
  // The worker's event subscription handles kind:3 events automatically
  // This function is kept for API compatibility but is now a no-op
}

async function crawlFollowLists(publicKey: string, depth = 2): Promise<void> {
  if (depth <= 0) return;

  const adapter = getWorkerAdapter();
  if (!adapter) return;

  socialGraphStore.setIsRecrawling(true);

  try {
    // Get current follows to check
    const rootFollows = await adapter.getFollows(publicKey);

    // Find users we need to fetch follow lists for
    const toFetch: string[] = [];
    for (const pk of rootFollows) {
      const theirFollows = await adapter.getFollows(pk);
      if (theirFollows.length === 0) {
        toFetch.push(pk);
      }
    }

    log('need to crawl', toFetch.length, 'users at depth 1');

    // Depth 2
    if (depth >= 2) {
      const toFetchSet = new Set(toFetch);

      for (const pk of rootFollows) {
        const theirFollows = await adapter.getFollows(pk);
        for (const pk2 of theirFollows) {
          if (!toFetchSet.has(pk2)) {
            const followsOfFollows = await adapter.getFollows(pk2);
            if (followsOfFollows.length === 0) {
              toFetchSet.add(pk2);
            }
          }
        }
      }

      log('total users needing crawl:', toFetchSet.size);
    }

    // Note: The worker's event subscription will fetch kind:3 events
    // We just identified who needs fetching here
  } finally {
    socialGraphStore.setIsRecrawling(false);
  }
}

async function setupSubscription(publicKey: string) {
  log('setting root to', publicKey);
  currentRoot = publicKey;

  const adapter = getWorkerAdapter();
  if (!adapter) return;

  try {
    await adapter.setSocialGraphRoot(publicKey);
  } catch (err) {
    console.error('[socialGraph] error setting root:', err);
  }

  // Trigger crawl in background
  queueMicrotask(() => crawlFollowLists(publicKey));
}

export async function setupSocialGraphSubscriptions() {
  const currentPublicKey = nostrStore.getState().pubkey;
  if (currentPublicKey) {
    await setupSubscription(currentPublicKey);
  }

  let prevPubkey = currentPublicKey;
  nostrStore.subscribe((state: NostrState) => {
    if (state.pubkey !== prevPubkey) {
      if (state.pubkey) {
        setupSubscription(state.pubkey);
      } else {
        currentRoot = DEFAULT_SOCIAL_GRAPH_ROOT;
        getWorkerAdapter()?.setSocialGraphRoot(DEFAULT_SOCIAL_GRAPH_ROOT).catch(() => {});
      }
      prevPubkey = state.pubkey;
    }
  });
}

// Worker handles SocialGraph init and kind:3 subscriptions internally
// App waits for restoreSession() before mounting, so worker is ready
