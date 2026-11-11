import { writable, type Readable } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import { LRUCache } from '../utils/lruCache';
import { KeyedEventEmitter } from '../utils/keyedEventEmitter';
import { nostr } from '../nostr/client';
import { queryConfiguredRelaysDirectly } from '../nostr/directQuery';


export interface Profile {
  pubkey: string;
  name?: string;
  display_name?: string;
  username?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  website?: string;
  banner?: string;
  lud16?: string;
  lud06?: string;
}

// In-memory profile cache
const profileCache = new LRUCache<string, Profile>(200);

// Track in-flight fetches to avoid duplicates
const pendingFetches = new Set<string>();

// Event emitter for profile updates
const profileEmitter = new KeyedEventEmitter<string, Profile>();

/**
 * Relays allow only a few subscriptions at a time, so profiles asked for together
 * share one lookup, and only a few lookups are open at once. A lookup stays open
 * until everyone in it has been answered: while the worker is busy (a first visit,
 * a profile whose follower lists are being read) an answer can reach the page long
 * after the relays reported the end of what they have, and a lookup closed at that
 * point would lose the name for good. Anyone still unanswered after a moment is
 * also asked for straight from the relays, so a busy worker does not hold names
 * back. Nothing waits for any of it: names and pictures fill in when they arrive.
 */
const PROFILE_BATCH_DELAY_MS = 100;
/** Once everyone has an answer, other relays get this long to send a newer copy. */
const PROFILE_SETTLE_MS = 1500;
/** A lookup that was never fully answered is given up after this long. */
const PROFILE_LISTEN_MAX_MS = 20000;
const PROFILE_BATCH_MAX_AUTHORS = 200;
const MAX_OPEN_LOOKUPS = 3;
/** How long the worker gets to answer before the relays are asked directly too. */
const PROFILE_DIRECT_AFTER_MS = 1500;
const PROFILE_DIRECT_MS = 6000;

const queuedPubkeys = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let openLookups = 0;

function flushProfileBatch(): void {
  batchTimer = null;
  if (openLookups >= MAX_OPEN_LOOKUPS) return;
  const authors = [...queuedPubkeys].slice(0, PROFILE_BATCH_MAX_AUTHORS);
  for (const author of authors) queuedPubkeys.delete(author);
  if (authors.length === 0) return;

  openLookups += 1;
  const unanswered = new Set(authors);
  const newestAt = new Map<string, number>();
  let closed = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const sub = nostr.subscribe({ kinds: [0], authors });
  let stopDirect: (() => void) | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(giveUpTimer);
    clearTimeout(directTimer);
    if (settleTimer) clearTimeout(settleTimer);
    sub.stop();
    stopDirect?.();
    openLookups -= 1;
    // A profile no relay had can be asked for again later.
    for (const author of authors) pendingFetches.delete(author);
    if (queuedPubkeys.size > 0) flushProfileBatch();
  };
  const giveUpTimer = setTimeout(close, PROFILE_LISTEN_MAX_MS);

  const handleProfileEvent = (event: { pubkey: string; created_at?: number; content: string }) => {
    unanswered.delete(event.pubkey);
    if (unanswered.size === 0) settleTimer ??= setTimeout(close, PROFILE_SETTLE_MS);
    // Keep most recent
    const createdAt = event.created_at || 0;
    if ((newestAt.get(event.pubkey) ?? -1) >= createdAt) return;
    try {
      const profile = JSON.parse(event.content) as Profile;
      profile.pubkey = event.pubkey;
      newestAt.set(event.pubkey, createdAt);
      profileCache.set(event.pubkey, profile);
      profileEmitter.notify(event.pubkey, profile);
    } catch (e) {
      console.error('[profile] JSON parse error', e);
    }
  };
  sub.on('event', handleProfileEvent);

  const directTimer = setTimeout(() => {
    if (closed || unanswered.size === 0) return;
    stopDirect = queryConfiguredRelaysDirectly([{ kinds: [0], authors: [...unanswered] }], handleProfileEvent, PROFILE_DIRECT_MS);
  }, PROFILE_DIRECT_AFTER_MS);

  if (queuedPubkeys.size > 0) flushProfileBatch();
}

function fetchProfile(pubkey: string): void {
  // Skip if fetch already in progress
  if (pendingFetches.has(pubkey)) {
    return;
  }

  pendingFetches.add(pubkey);
  queuedPubkeys.add(pubkey);
  batchTimer ??= setTimeout(flushProfileBatch, PROFILE_BATCH_DELAY_MS);
}

/**
 * Create a Svelte store for a profile
 */
export function createProfileStore(pubkey: string | undefined): Readable<Profile | undefined> {
  const pubkeyHex = pubkey
    ? pubkey.startsWith('npub1')
      ? (() => {
          try {
            const decoded = nip19.decode(pubkey);
            return decoded.data as string;
          } catch {
            return '';
          }
        })()
      : pubkey
    : '';

  const store = writable<Profile | undefined>(pubkeyHex ? profileCache.get(pubkeyHex) : undefined);

  if (pubkeyHex) {
    // Subscribe to updates
    const unsubListener = profileEmitter.subscribe(pubkeyHex, (profile) => {
      store.set(profile);
    });

    // Fetch if not cached
    if (!profileCache.get(pubkeyHex)) {
      fetchProfile(pubkeyHex);
    }

    return {
      subscribe: (run, invalidate) => {
        const unsubStore = store.subscribe(run, invalidate);
        return () => {
          unsubStore();
          unsubListener();
        };
      },
    };
  }

  return { subscribe: store.subscribe };
}

/**
 * Invalidate cached profile and refetch
 */
export function invalidateProfile(pubkey: string) {
  profileCache.delete(pubkey);
  pendingFetches.delete(pubkey);
  fetchProfile(pubkey);
}

/**
 * Get a name from profile, with fallback priority
 */
export function getProfileName(profile?: Profile, pubkey?: string): string | undefined {
  if (!profile && !pubkey) return undefined;

  if (profile) {
    return profile.display_name || profile.name || profile.username ||
           (profile.nip05 ? profile.nip05.split('@')[0] : undefined);
  }

  return undefined;
}

/**
 * Get cached profile synchronously (for non-reactive use)
 */
export function getProfileSync(pubkey: string): Profile | undefined {
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
  return profileCache.get(pubkeyHex);
}
