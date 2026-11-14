// @unocss-include: the icon classes below are built from this file.
import { isOwnShare, type AcceptedShareRecord } from '../drive/shareLibrary';

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
  const recent = currentPath === '/recent';
  const shared = inShared || currentPath === '/shared-with-me';
  return [
    {
      href: homeHref,
      label: 'My Drive',
      short: 'My Drive',
      icon: 'i-lucide-hard-drive',
      active: !recent && !shared && !currentPath.startsWith('/settings'),
    },
    { href: '#/recent', label: 'Recent', short: 'Recent', icon: 'i-lucide-clock-3', active: recent },
    { href: '#/shared-with-me', label: 'Shared with me', short: 'Shared', icon: 'i-lucide-users', active: shared },
  ];
}

/** Where Storage and Settings are, below the places. */
export const DRIVE_FOOTER_PLACES = [
  { href: '#/settings/storage', label: 'Storage', icon: 'i-lucide-database' },
  { href: '#/settings', label: 'Settings', icon: 'i-lucide-settings' },
] as const;
