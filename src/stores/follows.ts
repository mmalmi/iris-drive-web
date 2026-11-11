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
    // Own changes still being saved are shown on top of the list by their watcher.
    if (ownFollows.get(pubkey)?.pending.size) return;

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

/**
 * Follow and unfollow change the list on screen at once. The signed list is
 * published in the background, built on the newest own list known: the one the
 * worker has stored or a relay has sent. Nothing shown waits for a relay.
 */
export function followPubkey(targetPubkey: string): Promise<boolean> {
  return Promise.resolve(updateFollow(targetPubkey, true));
}

export function unfollowPubkey(targetPubkey: string): Promise<boolean> {
  return Promise.resolve(updateFollow(targetPubkey, false));
}

/** Set while a follow change is not saved yet or could not be saved; empty otherwise. */
export const followSaveError = writable('');

/** How long a known list waits for relays to send a newer one before it is built upon. */
const NEWER_HEAD_GRACE_MS = 1000;
const HISTORY_RETRY_MS = 5000;
const NOT_SAVED_NOTICE_MS = 10_000;

interface OwnFollows {
  /** Newest signed own list seen or published. */
  head: NostrEvent | null;
  /** Relays finished sending stored lists, so no list at all means there is none. */
  historyComplete: boolean;
  /** Changes made here that are not in a signed list yet: pubkey -> following. */
  pending: Map<string, boolean>;
  signing: boolean;
  sub: { stop: () => void } | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
}

const ownFollows = new Map<string, OwnFollows>();

function newerHead(current: NostrEvent | null, event: NostrEvent): NostrEvent {
  return !current || event.created_at > current.created_at ||
    (event.created_at === current.created_at && event.id < current.id) ? event : current;
}

function tagsWithPending(own: OwnFollows): string[][] {
  let tags = own.head?.tags.map(tag => [...tag]) ?? [];
  for (const [target, following] of own.pending) {
    const listed = tags.some(tag => tag[0] === 'p' && tag[1] === target);
    if (following && !listed) tags.push(['p', target]);
    if (!following && listed) tags = tags.filter(tag => !(tag[0] === 'p' && tag[1] === target));
  }
  return tags;
}

/** Show the newest known list with the changes still being saved applied on top. */
function showOwnFollows(pk: string, own: OwnFollows): void {
  let follows: string[];
  if (own.head) {
    follows = tagsWithPending(own).filter(tag => tag[0] === 'p' && tag[1]).map(tag => tag[1]);
  } else {
    // The signed list has not arrived yet: keep whatever is already on screen.
    follows = [...(followsCache.get(pk)?.follows ?? [])];
    for (const [target, following] of own.pending) {
      if (following && !follows.includes(target)) follows.push(target);
      if (!following) follows = follows.filter(pubkey => pubkey !== target);
    }
  }
  const shown: Follows = {
    pubkey: pk,
    follows,
    followedAt: own.head?.created_at ?? followsCache.get(pk)?.followedAt ?? 0,
  };
  followsCache.set(pk, shown);
  followsEmitter.notify(pk, shown);
}

function watchOwnFollows(pk: string, own: OwnFollows): void {
  own.sub?.stop();
  let current = true;
  const sub = nostr.subscribe({kinds: [3], authors: [pk]}, {closeAfterHistory: false});
  own.sub = {stop: () => { current = false; sub.stop(); }};
  sub.on('event', event => {
    if (!current || event.pubkey !== pk || event.kind !== 3) return;
    try {
      if (!verifyEvent(event)) return;
    } catch { return; }
    const head = newerHead(own.head, event);
    if (head === own.head) return;
    own.head = head;
    showOwnFollows(pk, own);
    if (own.pending.size > 0) scheduleOwnFollowsSave(pk, own);
  });
  sub.on('history', status => {
    if (!current) return;
    if (status?.complete) {
      own.historyComplete = true;
      void saveOwnFollows(pk, own);
    } else if (own.pending.size > 0 && !own.retryTimer) {
      // No relay could say whether a list exists. Ask again rather than
      // publish a list that might replace one this device has not seen.
      own.retryTimer = setTimeout(() => {
        own.retryTimer = null;
        if (own.pending.size > 0 && !own.historyComplete) watchOwnFollows(pk, own);
      }, HISTORY_RETRY_MS);
    }
  });
}

function ownFollowsFor(pk: string): OwnFollows {
  let own = ownFollows.get(pk);
  if (!own) {
    own = {
      head: null, historyComplete: false, pending: new Map(), signing: false,
      sub: null, graceTimer: null, retryTimer: null, noticeTimer: null,
    };
    ownFollows.set(pk, own);
    watchOwnFollows(pk, own);
  }
  return own;
}

function scheduleOwnFollowsSave(pk: string, own: OwnFollows): void {
  if (own.historyComplete) {
    void saveOwnFollows(pk, own);
  } else if (own.head && !own.graceTimer) {
    // A list is known. Give relays a moment to send a newer one, then go on
    // without them: one silent relay must not hold the change back.
    own.graceTimer = setTimeout(() => {
      own.graceTimer = null;
      void saveOwnFollows(pk, own, true);
    }, NEWER_HEAD_GRACE_MS);
  }
  if (own.pending.size > 0 && !own.noticeTimer) {
    own.noticeTimer = setTimeout(() => {
      own.noticeTimer = null;
      if (own.pending.size > 0) followSaveError.set('Not saved yet. Your follow list will be saved when connected.');
    }, NOT_SAVED_NOTICE_MS);
  }
}

async function saveOwnFollows(pk: string, own: OwnFollows, graceOver = false): Promise<void> {
  if (own.signing || own.pending.size === 0) return;
  // Without a known list, only finished relay history says there is none.
  if (!own.historyComplete && !(own.head && graceOver)) return;
  const signer = nostr.signer;
  if (nostrStore.getState().pubkey !== pk || !signer) {
    own.pending.clear();
    return;
  }
  const saving = new Map(own.pending);
  const tags = tagsWithPending(own);
  const unchanged = JSON.stringify(tags) === JSON.stringify(own.head?.tags ?? []);
  const settle = () => {
    for (const [target, following] of saving) {
      if (own.pending.get(target) === following) own.pending.delete(target);
    }
  };
  if (unchanged) {
    settle();
  } else {
    own.signing = true;
    try {
      const event = await nostr.signEvent({
        kind: 3,
        tags,
        content: own.head?.content ?? '',
        created_at: Math.max(Math.floor(Date.now() / 1000), (own.head?.created_at ?? 0) + 1),
      });
      if (event.pubkey !== pk || !verifyEvent(event)) throw new Error('Follow list was signed by another account.');
      own.head = newerHead(own.head, event);
      settle();
      followSaveError.set('');
      // The worker keeps the signed list in its outbox and retries delivery.
      void nostr.publish(event).catch(error => {
        console.error('[follows] Could not publish the follow list:', error);
        followSaveError.set('Could not send your follow list. It is saved on this device.');
      });
    } catch (error) {
      // Nothing was signed, so there is nothing queued to keep.
      console.error('[follows] Could not update the public follow list:', error);
      settle();
      followSaveError.set('Could not update follows.');
    } finally {
      own.signing = false;
    }
  }
  if (own.pending.size === 0 && own.noticeTimer) {
    clearTimeout(own.noticeTimer);
    own.noticeTimer = null;
  }
  showOwnFollows(pk, own);
  if (own.pending.size > 0) void saveOwnFollows(pk, own, graceOver);
}

function updateFollow(targetPubkey: string, following: boolean): boolean {
  const pk = nostrStore.getState().pubkey;
  if (!pk || !nostr.signer || !/^[a-f0-9]{64}$/.test(targetPubkey)) return false;
  const own = ownFollowsFor(pk);
  if (following) {
    rememberContact(pk, targetPubkey, getProfileName(getProfileSync(targetPubkey), targetPubkey) ?? null);
  }
  own.pending.set(targetPubkey, following);
  followSaveError.set('');
  showOwnFollows(pk, own);
  scheduleOwnFollowsSave(pk, own);
  return true;
}

/**
 * Invalidate cache for a pubkey (force refetch)
 */
export function invalidateFollows(pubkey: string): void {
  followsCache.delete(pubkey);
  fetchFollows(pubkey);
}
