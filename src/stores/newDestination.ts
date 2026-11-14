import { derived } from 'svelte/store';
import { buildRouteUrl } from '../actions/route';
import { activeDriveRootPath, isEditableDriveRouteScope } from '../drive/profileRoute';
import { acceptedShares } from '../drive/shareLibrary';
import { isDocumentFolderName } from '../lib/documentNames';
import { nostrStore } from '../nostr';
import { routeStore } from './route';

/** New uses the writable folder being viewed, or the person's own Drive from a read-only page. */
export const newDestination = derived([nostrStore, routeStore, acceptedShares], ([session, route, shares]) => {
  if (!session.isLoggedIn) return null;
  const canEdit = route.treeName && !route.isPermalink && (route.npub === session.npub
    || isEditableDriveRouteScope(route.npub, session, shares));
  if (!canEdit) return { href: `#${activeDriveRootPath(session)}`, inMyDrive: true };
  const documentAt = route.path.findIndex(isDocumentFolderName);
  const href = documentAt < 0 ? null
    : `#${buildRouteUrl(route.npub, route.treeName, route.path.slice(0, documentAt), undefined, route.params.get('k'))}`;
  return { href, inMyDrive: false };
});
