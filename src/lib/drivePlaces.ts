// @unocss-include: the icon classes below are built from this file.
import { isOwnShare, type AcceptedShareRecord } from '../drive/shareLibrary';
import { isNostrIdentityId } from '../utils/route';

/** A place in Drive, as the sidebar, its rail and the phone's tabs show it. */
export interface DrivePlace {
  href: string;
  label: string;
  /** For where there is little room: the rail and the phone's tabs. */
  short: string;
  icon: string;
  active: boolean;
}

/** Drive's places, and which one the page at `currentPath` belongs to. */
export function drivePlaces(currentPath: string, homeHref: string, records: AcceptedShareRecord[]): DrivePlace[] {
  const scope = currentPath.split('/').filter(Boolean)[0];
  // A folder shared with this profile; one it shared itself stays under My Drive.
  const inShared = records.some((record) => record.share_id === scope && !isOwnShare(record));
  const trash = currentPath === '/trash';
  const recent = currentPath === '/recent';
  const photos = currentPath === '/photos' || currentPath.startsWith('/photos/');
  const shared = inShared || currentPath === '/shared-with-me';
  // A Drive or shared folder this account holds no record of is no place of its own: "You need access".
  const homeScope = homeHref.replace(/^#?\//, '').split('/')[0];
  const unknown = isNostrIdentityId(scope) && scope !== homeScope
    && !records.some((record) => record.share_id === scope && record.local_profile_id === homeScope);
  return [
    {
      href: homeHref,
      label: 'My Drive',
      short: 'My Drive',
      icon: 'i-lucide-hard-drive',
      active: !trash && !recent && !photos && !shared && !unknown && !currentPath.startsWith('/settings'),
    },
    { href: '#/recent', label: 'Recent', short: 'Recent', icon: 'i-lucide-clock-3', active: recent },
    { href: '#/photos', label: 'Photos', short: 'Photos', icon: 'i-lucide-image', active: photos },
    { href: '#/shared-with-me', label: 'Shared with me', short: 'Shared', icon: 'i-lucide-users', active: shared },
    { href: '#/trash', label: 'Trash', short: 'Trash', icon: 'i-lucide-trash-2', active: trash },
  ];
}

/** Where Storage (with Backup) and Settings are, below the places. */
export const DRIVE_FOOTER_PLACES = [
  { href: '#/settings/storage', label: 'Storage', icon: 'i-lucide-database' },
  { href: '#/settings', label: 'Settings', icon: 'i-lucide-settings' },
] as const;
