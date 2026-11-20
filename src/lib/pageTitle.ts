import type { AcceptedShareRecord } from '../drive/shareLibrary';
import { DRIVE_ROOT_NAME } from '../drive/setup';
import { isNostrIdentityId, type RouteInfo } from '../utils/route';
import { getAppBrand } from './appBrand';
import { documentTitle, isDocumentFolderName, routeDocumentFolderName } from './documentNames';
import { COPY_NAME_PARAM } from './shareUrls';

type ShareName = Pick<AcceptedShareRecord, 'share_id'> & { folder: Pick<AcceptedShareRecord['folder'], 'display_name'> };

const PLACES: Record<string, string> = {
  recent: 'Recent',
  trash: 'Trash',
  'shared-with-me': 'Shared with me',
  photos: 'Photos',
};

const SIGN_IN_PAGES: Record<string, string> = {
  existing: 'Sign in',
  create: 'Create profile',
  no_existing: 'Create profile',
};

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The browser tab's title, as Google Drive writes it: the open file, folder,
 * document or place, then the app. Where nothing has a name, the app alone.
 */
export function pageTitle(path: string, route: RouteInfo, myDrive: string | null, shares: ShareName[]): string {
  const app = getAppBrand().displayName;
  const name = pageName(path, route, myDrive, shares);
  return name ? `${name} - ${app}` : app;
}

function pageName(path: string, route: RouteInfo, myDrive: string | null, shares: ShareName[]): string | null {
  const parts = path.split('/').filter(Boolean);
  const [first, second] = parts;
  const shareName = (scope: string | null | undefined) => shares.find((record) => record.share_id === scope)?.folder.display_name || null;

  if (first === 'settings') return second === 'storage' ? 'Storage' : 'Settings';
  if (first === 'users') return SIGN_IN_PAGES[second] ?? 'Profiles';
  if (first === 'photos' && second === 'album' && parts[2]) {
    return parts.length > 3 ? decode(parts.at(-1)!) : shareName(decode(parts[2])) ?? 'Photos';
  }
  if (first && PLACES[first]) return PLACES[first];
  if (isNostrIdentityId(first) && second === 'trash') return 'Trash';
  if (!route.treeName && !route.isPermalink) return null;

  // What is inside a document belongs to it; the document is what is open.
  const document = route.path.findLast(isDocumentFolderName) ?? routeDocumentFolderName(route);
  if (document) return documentTitle(document);
  if (route.path.length > 0) return route.path.at(-1)!;
  if (route.isPermalink) return route.params.get(COPY_NAME_PARAM) || null;
  if (route.npub === myDrive && route.treeName === DRIVE_ROOT_NAME) return 'My Drive';
  // A Drive this account holds no record of is no folder of its own; its address is no name.
  return shareName(route.npub) ?? (route.treeName === DRIVE_ROOT_NAME ? null : route.treeName);
}
