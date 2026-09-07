import { nostrStore } from '../nostr';
import { getCurrentNostrIdentitySession } from '../nostr/auth';
import { parseRoute } from '../utils/route';

/** Async writes may only publish into the route and identity that started them. */
export function captureRouteWriteGuard(): () => boolean {
  const scope = currentWriteScope();
  return () => scope === currentWriteScope();
}

function currentWriteScope(): string {
  const route = parseRoute();
  const state = nostrStore.getState();
  const session = getCurrentNostrIdentitySession();
  return JSON.stringify([
    route.npub, route.treeName, route.path,
    state.isLoggedIn, state.pubkey,
    session?.profileId, session?.appKeyPubkey, session?.status,
    state.selectedTree?.pubkey, state.selectedTree?.name, state.selectedTree?.visibility,
  ]);
}
