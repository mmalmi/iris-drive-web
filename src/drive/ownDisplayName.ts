import type { NostrIdentitySession } from './deviceLink';
import { createIdentityProfileNameStore } from '../stores/identityProfile';
import { accountsStore } from '../accounts';

/**
 * The name this account shows to others: the one chosen when the account was
 * made on this device, otherwise the one looked up like anyone else's. A
 * lookup that takes too long gives the account's generated name.
 */
export function ownDisplayName(session: NostrIdentitySession, waitMs = 2500): Promise<string> {
  const chosen = accountsStore.getState().accounts
    .find((account) => account.pubkey === session.appKeyPubkey)?.name?.trim();
  if (chosen) return Promise.resolve(chosen);
  const store = createIdentityProfileNameStore(session.profileId, session.appKeyPubkey);
  return new Promise((resolve) => {
    let latest = '';
    let done = false;
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe?.());
      resolve(latest);
    };
    const timer = setTimeout(finish, waitMs);
    unsubscribe = store.subscribe((state) => {
      latest = state.name;
      if (!state.loading) finish();
    });
  });
}

async function queryProfile(pubkey: string) {
  const [{ waitForSettingsLoaded }, { waitForWorkerAdapter }, { getNostrRelayUrls }] = await Promise.all([
    import('../stores/settings'), import('../lib/workerInit'), import('../nostr/client'),
  ]);
  await waitForSettingsLoaded();
  const adapter = await waitForWorkerAdapter();
  const relays = getNostrRelayUrls();
  if (!adapter?.queryEvents || !relays.length) throw Error('Connect to the network and try again.');
  return adapter.queryEvents([{ kinds: [0], authors: [pubkey], limit: 1 }], {
    cache: 'network-only', localEcho: false, relays, sources: [], deadline: Date.now() + 8000,
  });
}

/** Capture the signed profile when the user starts editing the displayed name. */
export async function readOwnNameBase(pubkey: string) {
  const [{ readOwnProfileHead }, { nostr }] = await Promise.all([
    import('@iris/hashtree-app/profileEdits'), import('../nostr/client'),
  ]);
  return readOwnProfileHead(nostr, pubkey, { query: queryProfile });
}

/** Save locally at once. Only publish the reviewed name on a verified profile. */
export async function saveOwnName(pubkey: string, name: string, base: ReturnType<typeof readOwnNameBase>): Promise<void> {
  const trimmed = name.trim().slice(0, 80);
  if (!pubkey || !trimmed) return;
  accountsStore.updateAccount(pubkey, { name: trimmed });
  const [original, { saveOwnProfileEdits }, { nostr }, { invalidateProfile }] = await Promise.all([
    base, import('@iris/hashtree-app/profileEdits'), import('../nostr/client'), import('../stores/profile'),
  ]);
  // New accounts get a searchable name. On existing profiles a rename edits only the display name.
  const edits = original ? { display_name: trimmed } : { name: trimmed, display_name: trimmed };
  await saveOwnProfileEdits(nostr, pubkey, original, edits, { query: queryProfile });
  invalidateProfile(pubkey);
}
