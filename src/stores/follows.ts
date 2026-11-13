/**
 * Follow lists read from relays, for the native app's social graph.
 */
import { writable } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { nostr } from '../nostr';

export interface Follows {
  pubkey: string;
  follows: string[];
  followedAt: number;
}

// Cache follows lists
const followsCache = new LRUCache<string, Follows>(100);

// Event emitter for follows updates
const followsEmitter = new KeyedEventEmitter<string, Follows>();

// Track active subscriptions - kept open for live updates
const activeSubscriptions = new Map<string, { stop: () => void }>();

/**
 * Subscribe to follows (kept open for live updates).
 * Subscriptions use the shared worker, including its persistent event index.
 */
function fetchFollows(pubkey: string): void {
  if (!pubkey || pubkey.length !== 64) {
    console.warn('[follows] Invalid pubkey:', pubkey);
    return;
  }

  // Already subscribed
  if (activeSubscriptions.has(pubkey)) return;

  // Track latest event timestamp to only process newer events
  let latestTimestamp = 0;

  const sub = nostr.subscribe(
    { kinds: [3], authors: [pubkey] },
    { closeAfterHistory: false } // Keep open for live updates
  );

  sub.on('event', (event: NostrEvent) => {
    const eventTime = event.created_at || 0;

    // Only process if newer than what we have
    if (eventTime <= Math.max(latestTimestamp, followsCache.get(pubkey)?.followedAt ?? 0)) return;
    latestTimestamp = eventTime;

    const followPubkeys = event.tags
      .filter(t => t[0] === 'p' && t[1])
      .map(t => t[1]);

    const follows: Follows = {
      pubkey: event.pubkey,
      follows: followPubkeys,
      followedAt: eventTime,
    };
    followsCache.set(pubkey, follows);
    followsEmitter.notify(pubkey, follows);
  });

  activeSubscriptions.set(pubkey, { stop: () => sub.stop() });
}

/**
 * Create a Svelte store for a user's follows list
 */
export function createFollowsStore(pubkey?: string) {
  const pubkeyHex = pubkey?.startsWith('npub1')
    ? (() => {
        try {
          const decoded = nip19.decode(pubkey);
          return decoded.data as string;
        } catch {
          return '';
        }
      })()
    : pubkey || '';

  const { subscribe: storeSubscribe, set } = writable<Follows | undefined>(
    pubkeyHex ? followsCache.get(pubkeyHex) : undefined
  );

  if (pubkeyHex) {
    // Subscribe to updates
    const unsub = followsEmitter.subscribe(pubkeyHex, set);

    // Fetch if not cached
    const cached = followsCache.get(pubkeyHex);
    if (cached) {
      set(cached);
    } else {
      fetchFollows(pubkeyHex);
    }

    // Return store with cleanup
    return {
      subscribe: storeSubscribe,
      destroy: unsub,
    };
  }

  return {
    subscribe: storeSubscribe,
    destroy: () => {},
  };
}

/**
 * Get follows synchronously (from cache)
 */
export function getFollowsSync(pubkey?: string): Follows | undefined {
  if (!pubkey) return undefined;
  const pubkeyHex = pubkey.startsWith('npub1')
    ? (() => {
        try {
          const decoded = nip19.decode(pubkey);
          return decoded.data as string;
        } catch {
          return '';
        }
      })()
    : pubkey;
  return followsCache.get(pubkeyHex);
}
