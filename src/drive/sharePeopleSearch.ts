import { get } from 'svelte/store';
import { nip19 } from 'nostr-tools';
import { nhashDecode, nhashEncode, type CID } from '@hashtree/core';
import { SearchIndex } from '@hashtree/index';
import { localStore } from '../store';
import { nostr, nostrStore } from '../nostr';
import { getFollows } from '../utils/socialGraph';
import { refreshSocialGraph } from '../lib/socialGraphRefresh';
import { indexUsers, searchUsers, type UserIndexEntry } from '../stores/searchIndex';
import { getProfileSync } from '../stores/profile';
import { acceptedShares } from './shareLibrary';
import { memberNpub, npubPubkey } from './people';
import { searchShareContacts, type RankedShareContact } from './shareContactSearch';

/**
 * Finding people to add to a shared folder or document, by name or key.
 *
 * Results come from three places and are shown as each answers, never
 * waiting for the slowest: people this device already knows (whom the account
 * follows, and the members of its shared folders), and the public profile
 * index iris.to also searches. They are ranked by follow distance first.
 */

const PROFILE_INDEX_NPUB = 'npub1yscmnnadrmvape0mvgzfx9uyl267klnhzy8znsr6ysl8wtxngpqsnx6dm0';
const PROFILE_INDEX_TREE = 'profile-search';
/** A published version of the index, used until a newer one is found. */
const PROFILE_INDEX_SNAPSHOT = import.meta.env.VITE_PROFILE_SEARCH_INDEX_SNAPSHOT
  || 'nhash1qqs2l0cus9gusd9q7njwhqva5card6vgasr2yahwpswccrtelvlnlcs9yrtr0lv032mslyg375sapxlzjtutvje6veznpj2sp89jzzknxxy96zg93n4';
const PROFILE_INDEX_ROOT_KEY = 'iris-drive.profile-search-root.v1';
const PROFILE_PREFIX = 'p:';
const INDEX_TIMEOUT_MS = 8000;
const AUTHORS_PER_REQUEST = 250;
const SHOWN = 8;

let profileIndex: SearchIndex | null = null;
let profileIndexRoot: CID | null = null;
let rootRefresh: Promise<void> | null = null;

function storedRoot(): CID | null {
  try {
    const stored = localStorage.getItem(PROFILE_INDEX_ROOT_KEY);
    if (stored) return nhashDecode(stored);
  } catch {
    // Fall back to the pinned version.
  }
  try {
    return nhashDecode(PROFILE_INDEX_SNAPSHOT);
  } catch {
    return null;
  }
}

/** Look for a newer index in the background; searches use the one known until then. */
function refreshIndexRoot(): void {
  rootRefresh ??= import('../stores/treeRoot')
    .then(({ waitForTreeRoot }) => waitForTreeRoot(PROFILE_INDEX_NPUB, PROFILE_INDEX_TREE, 20_000))
    .then((root) => {
      if (!root) return;
      profileIndexRoot = root;
      try {
        localStorage.setItem(PROFILE_INDEX_ROOT_KEY, nhashEncode(root));
      } catch {
        // Kept for this visit only.
      }
    })
    .catch(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => resolve(value), () => resolve(fallback)).finally(() => clearTimeout(timer));
  });
}

interface StoredProfile {
  pubkey?: string;
  name?: string;
  nip05?: string;
}

/** People in the public profile index whose names match. */
async function publishedProfiles(query: string, limit: number): Promise<UserIndexEntry[]> {
  if (query.replace(/\s+/g, '').length < 2) return [];
  refreshIndexRoot();
  const root = profileIndexRoot ?? storedRoot();
  if (!root) return [];
  profileIndex ??= new SearchIndex(localStore);
  const results = await withTimeout(profileIndex.search(root, PROFILE_PREFIX, query, { limit }), [], INDEX_TIMEOUT_MS);
  return results.flatMap((result, order) => {
    try {
      const stored = JSON.parse(result.value) as StoredProfile;
      const pubkey = (stored.pubkey || result.id).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pubkey)) return [];
      return [{ pubkey, npub: nip19.npubEncode(pubkey), name: stored.name, nip05: stored.nip05, order: 1000 + order }];
    } catch {
      return [];
    }
  });
}

/** Members of this account's shared folders whose names or keys match. */
function knownMembers(query: string): UserIndexEntry[] {
  const needle = query.trim().toLowerCase();
  const own = nostrStore.getState().pubkey;
  const found = new Map<string, UserIndexEntry>();
  for (const { folder } of get(acceptedShares)) {
    for (const grant of folder.access?.grants ?? []) {
      if (grant.target.type !== 'id' || grant.status !== 'active') continue;
      const npub = memberNpub(folder, grant.target.id);
      const pubkey = npub ? npubPubkey(npub) : null;
      if (!npub || !pubkey || pubkey === own || found.has(pubkey)) continue;
      const name = grant.display_name?.trim();
      if (`${name ?? ''} ${npub}`.toLowerCase().includes(needle)) {
        found.set(pubkey, { pubkey, npub, displayName: name, nostrIdentityId: grant.target.id, order: found.size });
      }
    }
  }
  return [...found.values()];
}

/** Followed people whose names have arrived, and when the others were last asked for. */
const named = new Set<string>();
const askedAt = new Map<string, number>();
const ASK_AGAIN_MS = 20_000;
/** Runs the search on screen again, once names that arrived are in the index. */
let showAgain: (() => void) | null = null;
let showAgainTimer: ReturnType<typeof setTimeout> | undefined;

function nameArrived(): void {
  clearTimeout(showAgainTimer);
  showAgainTimer = setTimeout(() => showAgain?.(), 400);
}

/**
 * Put the people this account follows into the local index, with the names
 * their profiles give as those arrive. Someone whose name has not come yet is
 * asked for again on a later search.
 */
async function indexFollowedPeople(): Promise<void> {
  const own = nostrStore.getState().pubkey;
  if (!own) return;
  const now = Date.now();
  const follows = await getFollows(own);
  const fresh = follows.filter((pubkey) => !askedAt.has(pubkey));
  const ask = follows.filter((pubkey) => !named.has(pubkey) && now - (askedAt.get(pubkey) ?? 0) > ASK_AGAIN_MS);
  if (fresh.length > 0) {
    void indexUsers(fresh.map((pubkey) => {
      const profile = getProfileSync(pubkey);
      return { pubkey, name: profile?.name, displayName: profile?.display_name, nip05: profile?.nip05 };
    }));
  }
  for (const pubkey of ask) askedAt.set(pubkey, now);
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  for (let at = 0; at < ask.length; at += AUTHORS_PER_REQUEST) {
    const sub = nostr.subscribe({ kinds: [0], authors: ask.slice(at, at + AUTHORS_PER_REQUEST) }, { closeAfterHistory: true });
    sub.on('event', (event: { pubkey: string; content: string }) => {
      try {
        const profile = JSON.parse(event.content) as Record<string, unknown>;
        const entry = {
          pubkey: event.pubkey,
          name: text(profile.name),
          displayName: text(profile.display_name) ?? text(profile.displayName),
          nip05: text(profile.nip05),
        };
        if (!entry.name && !entry.displayName && !entry.nip05) return;
        named.add(event.pubkey);
        void indexUsers([entry]);
        nameArrived();
      } catch {
        // A profile that does not parse adds nothing.
      }
    });
  }
}

async function localPeople(query: string, limit: number): Promise<UserIndexEntry[]> {
  const indexed = await withTimeout(searchUsers(query, limit), [], 2000);
  return [...knownMembers(query), ...indexed.map((entry, order) => ({ ...entry, order: 100 + order }))];
}

/**
 * Search, calling back first with what this device knows, again when the
 * public index answers, and again when names of followed people arrive.
 * Returns a function that stops calling back.
 */
export function searchPeopleToShare(
  query: string,
  onResults: (contacts: RankedShareContact[], done: boolean) => void,
): () => void {
  let current = true;
  let published: UserIndexEntry[] = [];
  let done = false;
  const show = async () => {
    const local = await localPeople(query, SHOWN * 2);
    if (!current) return;
    const contacts = await searchShareContacts(query, { limit: SHOWN, userSearch: async () => [...local, ...published] });
    if (current) onResults(contacts, done);
  };
  const again = () => { void show().catch(() => undefined); };
  showAgain = again;
  // Follow lists for ranking catch up in the background, at most every few minutes.
  refreshSocialGraph();
  void (async () => {
    // The follow list is the worker's; asking it does not wait for relays.
    await withTimeout(indexFollowedPeople(), undefined, 1500);
    await show();
    published = await publishedProfiles(query, SHOWN * 2);
    done = true;
    await show();
  })().catch(() => {
    if (current) onResults([], true);
  });
  return () => {
    current = false;
    if (showAgain === again) showAgain = null;
  };
}
