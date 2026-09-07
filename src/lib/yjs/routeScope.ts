import { isActiveNostrIdentityRouteScope } from '../../drive/profileRoute';

type EditableNostrState = {
  isLoggedIn: boolean;
  pubkey: string | null;
};

export type YjsRouteScopes = {
  isOwnTree: boolean;
  ownerNpub: string | null;
  viewedRootScope: string | null;
  writeRootScope: string | null;
};

/**
 * Keep storage addressing separate from collaborator identity. An active Drive
 * is stored under its stable profile UUID even though its local signer and
 * collaborator identity remain the AppKey npub.
 */
export function resolveYjsRouteScopes(
  routeScope: string | null,
  userNpub: string | null,
  state: EditableNostrState,
): YjsRouteScopes {
  const isProfileDrive = isActiveNostrIdentityRouteScope(routeScope, state);
  const viewedRootScope = routeScope || userNpub;
  return {
    isOwnTree: !routeScope || routeScope === userNpub || isProfileDrive,
    ownerNpub: isProfileDrive ? userNpub : (routeScope || userNpub),
    viewedRootScope,
    // Collaborators deliberately publish their deltas/attachments to their
    // own npub tree; only the active profile owner writes to the UUID root.
    writeRootScope: isProfileDrive ? routeScope : userNpub,
  };
}
