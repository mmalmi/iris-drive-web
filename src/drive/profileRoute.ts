import type { NostrState } from '../nostr/store';
import { getCurrentIrisIdentitySession } from '../nostr/auth';
import { isIrisProfileId } from '../utils/route';

type EditableState = Pick<NostrState, 'isLoggedIn' | 'pubkey'>;

export function isActiveIrisProfileRouteScope(
  scope: string | null | undefined,
  state?: EditableState,
): boolean {
  if (!scope || !isIrisProfileId(scope)) return false;
  const session = getCurrentIrisIdentitySession();
  if (!session || session.status !== 'active' || session.profileId !== scope) return false;
  if (!state) return true;
  return state.isLoggedIn && state.pubkey === session.appKeyPubkey;
}
