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

const PROFILE_WAIT_MS = 8000;

/**
 * Change the name this account shows to others. It is kept on this device at
 * once and used for folders shared from now on; the public profile follows in
 * the background, keeping whatever else that profile already says.
 */
export function saveOwnName(pubkey: string, name: string): void {
  const trimmed = name.trim().slice(0, 80);
  if (!pubkey || !trimmed) return;
  accountsStore.updateAccount(pubkey, { name: trimmed });
  const account = accountsStore.getState().accounts.find((item) => item.pubkey === pubkey);
  void publishOwnName(pubkey, trimmed, account?.type === 'drive_profile').catch((error) => {
    console.warn('[name] Could not publish the new name:', error);
  });
}

async function publishOwnName(pubkey: string, name: string, generatedKey: boolean): Promise<void> {
  const [{ createProfileStore, getProfileSync, invalidateProfile }, { publishEvent }] = await Promise.all([
    import('../stores/profile'),
    import('../lib/nostrPublish'),
  ]);
  type Known = ReturnType<typeof getProfileSync>;
  // A key made by Drive only ever had profiles Drive wrote, so it need not wait for one.
  const known = getProfileSync(pubkey) ?? (generatedKey ? undefined : await new Promise<Known>((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const finish = (value: Known) => {
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe?.());
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), PROFILE_WAIT_MS);
    unsubscribe = createProfileStore(pubkey).subscribe((value) => { if (value) finish(value); });
  }));
  // A key made by Drive has no other profile to keep. Any other key might, so
  // without its current profile nothing is published that could replace it.
  if (!known && !generatedKey) return;
  const fields: Record<string, unknown> = { ...known };
  delete fields.pubkey;
  await publishEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ ...fields, name, display_name: name }),
  });
  invalidateProfile(pubkey);
}
