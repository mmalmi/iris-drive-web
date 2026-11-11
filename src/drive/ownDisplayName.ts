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
