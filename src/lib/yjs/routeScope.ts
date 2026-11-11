import { isEditableDriveRouteScope } from '../../drive/profileRoute';
import type { AcceptedShareRecord } from '../../drive/shareLibrary';

type EditableNostrState = {
  isLoggedIn: boolean;
  pubkey: string | null;
};

/**
 * The root a document on this route is written to, or null when the account
 * may only read it. A Drive or shared folder is addressed by its stable id; an
 * editor of a shared folder writes into that folder, where Drive merges every
 * writer's files.
 */
export function documentWriteScope(
  routeScope: string | null | undefined,
  userNpub: string | null,
  state: EditableNostrState,
  /** Pass the current shared folders so the answer follows access changes. */
  shares?: AcceptedShareRecord[],
): string | null {
  if (!routeScope || !state.isLoggedIn || !state.pubkey) return null;
  return routeScope === userNpub || isEditableDriveRouteScope(routeScope, state, shares) ? routeScope : null;
}
