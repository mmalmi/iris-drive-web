import { activeShareScope } from './shareScope';
import type { AcceptedShareRecord } from './shareLibrary';
import type { NostrState } from '../nostr/store';
import { nip19 } from 'nostr-tools';
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

export function isEditableDriveRouteScope(
  scope: string | null | undefined, state?: EditableState, shares?: AcceptedShareRecord[],
): boolean {
  return isActiveNostrIdentityRouteScope(scope, state) || Boolean(activeShareScope(scope, state, shares)?.canWrite);
}

/**
 * Resolve an editable tree route to the current AppKey pubkey.
 *
 * Drive profile routes use a stable UUID while legacy tree routes use an
 * npub. Keeping this ownership check in one place prevents empty-tree
 * initialization from silently treating active profile routes as read-only.
 */
export function editableTreeRoutePubkey(
  scope: string | null | undefined,
  state: EditableState,
): string | null {
  if (!scope || !state.isLoggedIn || !state.pubkey) return null;
  if (isEditableDriveRouteScope(scope, state)) return state.pubkey;

  try {
    const decoded = nip19.decode(scope);
    if (decoded.type === 'npub' && decoded.data === state.pubkey) {
      return state.pubkey;
    }
  } catch {
    // A non-npub route is editable only when it is the active profile UUID.
  }
  return null;
}

export function activeDriveRootPath(state: DriveHomeState): string {
  if (!state.isLoggedIn) return '/';

  const scope = activeNostrIdentityRootScope(state) ?? state.npub;
  return scope ? driveRootPath(scope) : '/';
}
