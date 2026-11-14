import { isEditableDriveRouteScope } from '../drive/profileRoute';
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
  // A profile Drive is identified by its route. Its sidebar selection can finish
  // loading while a write to that same Drive is already underway.
  const writableDrive = Boolean(route.treeName && isEditableDriveRouteScope(route.npub, state));
  const selected = writableDrive ? null : state.selectedTree;
  return JSON.stringify([
    route.npub, route.treeName, route.path,
    currentIdentity(), writableDrive,
    selected?.pubkey, selected?.name, selected?.visibility,
  ]);
}
