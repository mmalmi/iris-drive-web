/**
 * Photos: every picture and video in My Drive and in the shared folders this
 * device holds, newest first, under a heading for each day of the last month
 * and for each month before.
 */
import { LinkType, toHex, type CID } from '@hashtree/core';
import type { AcceptedShareRecord } from '../drive/shareLibrary';
import { modifiedAt } from './modifiedAt';
import { driveHref, type DriveFound, type DriveRoot } from './driveWalk';

/** Pictures a browser shows, and those of phones it may not (they show as an icon there). */
const PICTURE = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp)$/i;
/** Where pictures and videos uploaded in Photos go, at the top of My Drive. */
export const PHOTOS_FOLDER = 'Photos';
/** Days up to this many back each have a heading; before them, each month. */
const DAYS_SHOWN = 30;

export interface Photo {
  /** Unique: where the file opens in Drive. */
  href: string;
  name: string;
  cid: CID;
  /** The content's hash, by which its date is kept. */
  hash: string;
  size: number;
  /** The tree's label and the folders above it. */
  where: string;
  video: boolean;
  /** When it was last changed in Drive, in Unix seconds. */
  modified: number | null;
}

export interface PhotoGroup {
  key: string;
  label: string;
  photos: Photo[];
}

export function isPhotoName(name: string): boolean {
  return PICTURE.test(name) || VIDEO.test(name);
}

export function isVideoName(name: string): boolean {
  return VIDEO.test(name);
}

/** The pictures and videos among what was found in a tree. */
export function photosFound(root: DriveRoot, found: readonly DriveFound[]): Photo[] {
  const photos: Photo[] = [];
  for (const { path, entry } of found) {
    if (entry.type === LinkType.Dir || !isPhotoName(entry.name)) continue;
    photos.push({
      href: driveHref(root.scope, path),
      name: entry.name,
      cid: entry.cid,
      hash: toHex(entry.cid.hash),
      size: entry.size,
      where: [root.label, ...path.slice(0, -1)].join(' / '),
      video: isVideoName(entry.name),
      modified: modifiedAt(entry),
    });
  }
  return photos;
}

/** When a photo was taken, as far as is known: the camera's own date, or when it changed in Drive. */
export function photoDate(photo: Photo, taken: ReadonlyMap<string, number | null>): number | null {
  return taken.get(photo.hash) ?? photo.modified;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The heading a date is shown under: "Today", "Yesterday", "12 Nov", or "October 2026" before the last month. */
export function dateHeading(seconds: number | null, now = new Date(), locale?: string): { key: string; label: string } {
  if (seconds === null) return { key: 'none', label: 'No date' };
  const date = new Date(seconds * 1000);
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (daysAgo < DAYS_SHOWN) {
    const key = `d:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    if (daysAgo === 0) return { key, label: 'Today' };
    if (daysAgo === 1) return { key, label: 'Yesterday' };
    const sameYear = date.getFullYear() === now.getFullYear();
    return { key, label: date.toLocaleDateString(locale, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }) };
  }
  return {
    key: `m:${date.getFullYear()}-${date.getMonth() + 1}`,
    label: date.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
  };
}

/** The photos newest first under their date headings; those with no date last. */
export function arrangePhotos(photos: Photo[], taken: ReadonlyMap<string, number | null>, now = new Date(), locale?: string): PhotoGroup[] {
  const dated = photos.map((photo) => ({ photo, date: photoDate(photo, taken) }));
  dated.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity) || a.photo.name.localeCompare(b.photo.name) || a.photo.href.localeCompare(b.photo.href));
  const groups: PhotoGroup[] = [];
  for (const { photo, date } of dated) {
    const heading = dateHeading(date, now, locale);
    const last = groups[groups.length - 1];
    if (last?.key === heading.key) last.photos.push(photo);
    else groups.push({ ...heading, photos: [photo] });
  }
  return groups;
}

/**
 * Where Photos puts what is uploaded there: the Photos folder at the top of
 * My Drive, or the shared folder it has become when it was shared.
 */
export function photosUploadPlace(ownScope: string, ownProfileId: string | null, records: AcceptedShareRecord[]): { scope: string; path: string[] } {
  const shared = ownProfileId
    ? records.find((record) => record.local_profile_id === ownProfileId
      && record.folder.owner_profile_id === ownProfileId
      && record.folder.source_path === PHOTOS_FOLDER)
    : undefined;
  return shared ? { scope: shared.share_id, path: [] } : { scope: ownScope, path: [PHOTOS_FOLDER] };
}
