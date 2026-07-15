import type { NostrState } from '../nostr/store';
import { getCurrentNostrIdentitySession } from '../nostr/auth';
import { isNostrIdentityId } from '../utils/route';
import { driveRootPath } from './setup';

type EditableState = Pick<NostrState, 'isLoggedIn' | 'pubkey'>;
type DriveHomeState = Pick<NostrState, 'isLoggedIn' | 'pubkey' | 'npub'>;

export function activeNostrIdentityRootScope(state?: EditableState): string | null {
  const session = getCurrentNostrIdentitySession();
  if (!session || session.status !== 'active') return null;
  if (state && (!state.isLoggedIn || state.pubkey !== session.appKeyPubkey)) return null;
  return session.profileId;
}

export function isActiveNostrIdentityRouteScope(
  scope: string | null | undefined,
  state?: EditableState,
): boolean {
  if (!scope || !isNostrIdentityId(scope)) return false;
  return activeNostrIdentityRootScope(state) === scope;
}

export function activeDriveRootPath(state: DriveHomeState): string {
  if (!state.isLoggedIn) return '/';

  const scope = activeNostrIdentityRootScope(state) ?? state.npub;
  return scope ? driveRootPath(scope) : '/';
}
