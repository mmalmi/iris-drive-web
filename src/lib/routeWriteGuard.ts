import { nostrStore } from '../nostr';
import { getCurrentNostrIdentitySession } from '../nostr/auth';
import { parseRoute } from '../utils/route';

/** Async writes may only publish into the route and identity that started them. */
export function captureRouteWriteGuard(): () => boolean {
  const scope = currentWriteScope();
  return () => scope === currentWriteScope();
}

/**
 * For writes saved to a Drive by its own address, wherever the page has gone
 * since: they may finish while the same account is signed in.
 */
export function captureIdentityWriteGuard(): () => boolean {
  const identity = currentIdentity();
  return () => identity === currentIdentity();
}

function currentIdentity(): string {
  const state = nostrStore.getState();
  const session = getCurrentNostrIdentitySession();
  return JSON.stringify([
    state.isLoggedIn, state.pubkey,
    session?.profileId, session?.appKeyPubkey, session?.status,
  ]);
}

function currentWriteScope(): string {
  const route = parseRoute();
  const state = nostrStore.getState();
  return JSON.stringify([
    route.npub, route.treeName, route.path,
    currentIdentity(),
    state.selectedTree?.pubkey, state.selectedTree?.name, state.selectedTree?.visibility,
  ]);
}
