/**
 * follows hook - manages follow lists and follow/unfollow actions
 * Svelte version using writable stores
 */
import { writable } from 'svelte/store';
import { rememberContact } from './contactMemory';
import { getProfileName, getProfileSync } from './profile';
import { nip19, verifyEvent } from 'nostr-tools';
import type { Event as NostrEvent } from 'nostr-tools';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { nostr, nostrStore } from '../nostr';
import { getNostrRelayUrls } from '../nostr/client';
import { getWorkerAdapter } from '../workerAdapter';

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

/** Follow/unfollow only after the backend has completed the latest own history. */
export function followPubkey(targetPubkey: string): Promise<boolean> {
  return updateFollow(targetPubkey, true);
}

export function unfollowPubkey(targetPubkey: string): Promise<boolean> {
  return updateFollow(targetPubkey, false);
}

let followUpdates: Promise<unknown> = Promise.resolve();
const publishedHeads = new Map<string, NostrEvent>();

function newerHead(current: NostrEvent | null, event: NostrEvent): NostrEvent {
  return !current || event.created_at > current.created_at ||
    (event.created_at === current.created_at && event.id < current.id) ? event : current;
}

async function loadOwnFollowHead(pk: string): Promise<NostrEvent | null> {
  const adapter = getWorkerAdapter();
  if (adapter?.queryEvents) {
    const relays = getNostrRelayUrls();
    if (relays.length === 0) throw new Error('No follow history servers are configured.');
    // Optional peer sources may have no complete history. Require all configured
    // relays while retaining any newer signed head already stored locally.
    const result = await adapter.queryEvents([{kinds: [3], authors: [pk]}], {
      cache: 'cache-first', relays, deadline: Date.now() + 10_000,
    });
    if (adapter !== getWorkerAdapter() || !result.complete) {
      throw new Error('Follow history is incomplete.');
    }
    let latest: NostrEvent | null = null;
    for (const event of result.events) {
      if (event.pubkey !== pk || event.kind !== 3) continue;
      if (!verifyEvent(event)) throw new Error('Follow history is invalid.');
      latest = newerHead(latest, event);
    }
    return latest;
  }
  // Native backends without the worker query API report their own completion.
  return new Promise((resolve, reject) => {
    let latest: NostrEvent | null = null;
    let invalidHead = false;
    let settled = false;
    const sub = nostr.subscribe({kinds: [3], authors: [pk]}, {closeAfterHistory: true});
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.stop();
      if (error) reject(error); else resolve(latest);
    };
    const timer = setTimeout(() => finish(new Error('Follow history is incomplete.')), 10_000);
    sub.on('event', event => {
      if (event.pubkey !== pk || event.kind !== 3) return;
      try {
        if (!verifyEvent(event)) { invalidHead = true; return; }
        latest = newerHead(latest, event);
      } catch { invalidHead = true; }
    });
    sub.on('history', status => {
      finish(status.complete && !invalidHead ? undefined : new Error('Follow history is incomplete or invalid.'));
    });
    sub.on('close', () => finish(new Error('Follow history closed before completion.')));
  });
}

function updateFollow(targetPubkey: string, following: boolean): Promise<boolean> {
  const pk = nostrStore.getState().pubkey;
  const signer = nostr.signer;
  if (!pk || !signer || !/^[a-f0-9]{64}$/.test(targetPubkey)) return Promise.resolve(false);
  const initialName = getProfileName(getProfileSync(targetPubkey), targetPubkey) ?? null;
  const operation = followUpdates.then(async () => {
    if (nostrStore.getState().pubkey !== pk || nostr.signer !== signer) return false;
    let head = await loadOwnFollowHead(pk);
    if (nostrStore.getState().pubkey !== pk || nostr.signer !== signer) return false;
    // Preserve a successful local update while relays are still catching up.
    const publishedHead = publishedHeads.get(pk);
    if (publishedHead) head = newerHead(head, publishedHead);
    const tags = head?.tags.map(tag => [...tag]) ?? [];
    const alreadyFollowing = tags.some(tag => tag[0] === 'p' && tag[1] === targetPubkey);
    if (alreadyFollowing !== following) {
      const nextTags = following ? [...tags, ['p', targetPubkey]] :
        tags.filter(tag => !(tag[0] === 'p' && tag[1] === targetPubkey));
      const event = await nostr.publishEvent({
        kind: 3,
        tags: nextTags,
        content: head?.content ?? '',
        created_at: Math.max(Math.floor(Date.now() / 1000), (head?.created_at ?? 0) + 1),
      });
      if (event.pubkey !== pk || !verifyEvent(event)) return false;
      head = event;
      publishedHeads.set(pk, event);
    }
    const saved: Follows = {
      pubkey: pk,
      follows: head?.tags.filter(tag => tag[0] === 'p' && tag[1]).map(tag => tag[1]) ?? [],
      followedAt: head?.created_at ?? 0,
    };
    followsCache.set(pk, saved);
    followsEmitter.notify(pk, saved);
    if (following) rememberContact(pk, targetPubkey, initialName);
    return true;
  }).catch(error => {
    console.error('[follows] Could not update the public follow list:', error);
    return false;
  });
  followUpdates = operation;
  return operation;
}

/**
 * Invalidate cache for a pubkey (force refetch)
 */
export function invalidateFollows(pubkey: string): void {
  followsCache.delete(pubkey);
  fetchFollows(pubkey);
}
