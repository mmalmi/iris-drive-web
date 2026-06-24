import { fallbackIdentityName } from '@iris/svelte-ui/profile';
import {
  representativeProfileAuthors,
  selectLatestRepresentativeProfileEvent,
  type NostrProfileEventLike,
} from '@iris/identity';
import { verifyEvent, type Event as NostrToolsEvent } from 'nostr-tools';
import { writable, type Readable } from 'svelte/store';
import {
  KIND_IRIS_PROFILE_ROSTER_OP,
  parseIrisProfileRosterOpEvent,
  projectIrisProfileRoster,
  type SignedIrisProfileRosterOp,
} from '../drive/protocol';
import { configureNdkRelays, ndk } from '../nostr/ndk';
import { getStoredIrisIdentitySessionForAccount } from '../nostr/auth';
import { DEFAULT_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';
import { getProfileName, type Profile } from './profile';

export interface IdentityProfileNameState {
  name: string;
  fallbackName: string;
  representativePubkey?: string;
  loading: boolean;
}

const nameStores = new Map<string, Readable<IdentityProfileNameState>>();
let identityProfileRelayConnectPromise: Promise<void> | null = null;
const HEX_IDENTIFIER_RE = /^[0-9a-f]{64}$/i;
const SHORT_HEX_IDENTIFIER_RE = /^[0-9a-f]{6,}\.{3}[0-9a-f]{4,}$/i;
const UUID_IDENTIFIER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOSTR_IDENTIFIER_RE = /^n(pub|profile)1[02-9ac-hj-np-z]+$/i;

export function createIdentityProfileNameStore(
  profileId: string | undefined,
  appKeyPubkey: string,
): Readable<IdentityProfileNameState> {
  const key = `${profileId ?? ''}:${appKeyPubkey}`;
  const existing = nameStores.get(key);
  if (existing) return existing;

  const fallbackName = fallbackIdentityName(profileId || appKeyPubkey);
  const store = writable<IdentityProfileNameState>({
    name: fallbackName,
    fallbackName,
    loading: true,
  });

  void resolveIdentityProfileName(profileId, appKeyPubkey, fallbackName, store);

  nameStores.set(key, { subscribe: store.subscribe });
  return nameStores.get(key)!;
}

async function resolveIdentityProfileName(
  profileId: string | undefined,
  appKeyPubkey: string,
  fallbackName: string,
  store: ReturnType<typeof writable<IdentityProfileNameState>>,
): Promise<void> {
  const projection = await identityProjectionForAccount(profileId, appKeyPubkey);
  const authors = projection ? representativeProfileAuthors(projection) : [];
  if (authors.length === 0 || !projection) {
    store.set({ name: fallbackName, fallbackName, loading: false });
    return;
  }
  await fetchIdentityProfileName(authors, projection, fallbackName, store);
}

async function identityProjectionForAccount(
  profileId: string | undefined,
  appKeyPubkey: string,
): Promise<NonNullable<ReturnType<typeof projectIrisProfileRoster>> | null> {
  const session = getStoredIrisIdentitySessionForAccount(appKeyPubkey);
  if (session) {
    return projectIrisProfileRoster(session.profileId, session.rosterOps);
  }
  if (!profileId) return null;
  const rosterOps = await fetchIdentityRosterOps(profileId);
  return rosterOps.length > 0 ? projectIrisProfileRoster(profileId, rosterOps) : null;
}

async function fetchIdentityRosterOps(
  profileId: string,
  timeoutMs = 5000,
): Promise<SignedIrisProfileRosterOp[]> {
  await ensureIdentityProfileRelays();
  const byId = new Map<string, SignedIrisProfileRosterOp>();

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const sub = ndk.subscribe(
      { kinds: [KIND_IRIS_PROFILE_ROSTER_OP], '#i': [profileId], limit: 500 },
      { closeOnEose: true },
    );
    const timer = setTimeout(finish, timeoutMs);

    sub.on('event', (event) => {
      try {
        const raw = event.rawEvent() as NostrToolsEvent;
        if (!verifyEvent(raw)) {
          console.warn('[identityProfile] Ignoring roster event with invalid signature');
          return;
        }
        const signed = parseIrisProfileRosterOpEvent(raw);
        if (signed.content.profile_id === profileId) {
          byId.set(signed.op_id, signed);
        }
      } catch (error) {
        console.warn('[identityProfile] Ignoring invalid roster event:', error);
      }
    });
    sub.on('eose', finish);
  });

  return Array.from(byId.values())
    .sort((left, right) => left.content.created_at - right.content.created_at || left.op_id.localeCompare(right.op_id));
}

async function fetchIdentityProfileName(
  authors: string[],
  projection: NonNullable<ReturnType<typeof projectIrisProfileRoster>>,
  fallbackName: string,
  store: ReturnType<typeof writable<IdentityProfileNameState>>,
): Promise<void> {
  await ensureIdentityProfileRelays();

  const events: NostrProfileEventLike[] = [];
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      sub.stop();
      resolve();
    };
    const sub = ndk.subscribe(
      { kinds: [0], authors, limit: Math.max(20, authors.length) },
      { closeOnEose: true },
    );
    const timer = setTimeout(finish, 5000);

    sub.on('event', (event) => {
      const raw = event.rawEvent() as NostrToolsEvent;
      if (!verifyEvent(raw)) {
        console.warn('[identityProfile] Ignoring profile event with invalid signature');
        return;
      }
      events.push({
        kind: raw.kind,
        pubkey: raw.pubkey,
        created_at: raw.created_at,
        content: raw.content,
      });

      const next = identityNameFromEvents(projection, events, fallbackName);
      store.set(next);
    });
    sub.on('eose', finish);
  });

  store.set(identityNameFromEvents(projection, events, fallbackName, false));
}

function identityNameFromEvents(
  projection: NonNullable<ReturnType<typeof projectIrisProfileRoster>>,
  events: NostrProfileEventLike[],
  fallbackName: string,
  loading = true,
): IdentityProfileNameState {
  const representative = selectLatestRepresentativeProfileEvent(projection, events);
  const profileName = representative
    ? getProfileName(representative.profile as Profile, representative.pubkey)
    : undefined;
  const name = displayNameOrFallback(profileName, fallbackName);
  return {
    name,
    fallbackName,
    representativePubkey: representative?.pubkey,
    loading,
  };
}

function displayNameOrFallback(name: string | undefined, fallbackName: string): string {
  const candidate = name?.trim();
  if (!candidate || isMachineIdentifier(candidate)) return fallbackName;
  return candidate;
}

function isMachineIdentifier(value: string): boolean {
  return HEX_IDENTIFIER_RE.test(value)
    || SHORT_HEX_IDENTIFIER_RE.test(value)
    || UUID_IDENTIFIER_RE.test(value)
    || NOSTR_IDENTIFIER_RE.test(value);
}

function ensureIdentityProfileRelays(): Promise<void> {
  if (ndk.explicitRelayUrls.length > 0 || ndk.pool.relays.size > 0) {
    return Promise.resolve();
  }
  identityProfileRelayConnectPromise ??= configureNdkRelays(DEFAULT_PUBLIC_RELAYS, 3000)
    .catch((error) => {
      console.warn('[identityProfile] Failed to connect profile relays', error);
    })
    .finally(() => {
      identityProfileRelayConnectPromise = null;
    });
  return identityProfileRelayConnectPromise;
}
