/**
 * Photos: every picture and video in My Drive and in the shared folders this
 * device holds, newest first, under a heading for each day of the last month
 * and for each month before; and albums, the folders that hold them.
 *
 * One photo can be in several folders, as copies of the same content. The
 * timeline shows it once; each album shows its own copy.
 */
import { LinkType, toHex, type CID } from '@hashtree/core';
import type { AcceptedShareRecord } from '../drive/shareLibrary';
import { modifiedAt } from './modifiedAt';
import { freeName } from './driveClipboard';
import { isDocumentFolderName } from './documentNames';
import { isHiddenDirectoryName } from './directoryEntryVisibility';
import { driveHref, type DriveFound, type DriveRoot } from './driveWalk';

/** Pictures a browser shows, and those of phones it may not (they show as an icon there). */
const PICTURE = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|heic|heif)$/i;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp)$/i;
/** Where pictures and videos uploaded in Photos go, and new albums, at the top of My Drive. */
export const PHOTOS_FOLDER = 'Photos';
/** Days up to this many back each have a heading; before them, each month. */
const DAYS_SHOWN = 30;

export interface Photo {
  /** Unique: where the file opens in Drive. */
  href: string;
  name: string;
  cid: CID;
  type: LinkType;
  /** The content's hash: copies of one photo share it, and its date is kept by it. */
  hash: string;
  size: number;
  /** The tree it is in, and where in it, ending with its own name. */
  scope: string;
  path: string[];
  /** The tree's label: "My Drive" or the shared folder's name. */
  label: string;
  /** The tree is a shared folder. */
  shared: boolean;
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

/** A folder that holds photos itself. */
export interface Album {
  /** Unique, and its address: the tree and the folder's path. */
  key: string;
  scope: string;
  path: string[];
  name: string;
  /** Its own photos, not those of folders in it, newest first. */
  photos: Photo[];
}

/** When a photo was taken, as far as is known. */
export type PhotoDating = (photo: Photo) => number | null;

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
      type: entry.type,
      hash: toHex(entry.cid.hash),
      size: entry.size,
      scope: root.scope,
      path,
      label: root.label,
      shared: !!root.shared,
      where: [root.label, ...path.slice(0, -1)].join(' / '),
      video: isVideoName(entry.name),
      modified: modifiedAt(entry),
    });
  }
  return photos;
}

/**
 * When each photo was taken, as far as is known: the camera's own date, or
 * else when its content first came into the Drive, so that adding it to an
 * album later does not make it new.
 */
export function photoDating(photos: readonly Photo[], taken: ReadonlyMap<string, number | null>): PhotoDating {
  const first = new Map<string, number>();
  for (const photo of photos) {
    if (photo.modified !== null && photo.modified < (first.get(photo.hash) ?? Infinity)) first.set(photo.hash, photo.modified);
  }
  return (photo) => taken.get(photo.hash) ?? first.get(photo.hash) ?? photo.modified;
}

/** Each photo once, whatever folders it is in: the copy that came into the Drive first. */
export function uniquePhotos(photos: readonly Photo[]): Photo[] {
  const kept = new Map<string, Photo>();
  for (const photo of photos) {
    const other = kept.get(photo.hash);
    if (!other || (photo.modified ?? Infinity) < (other.modified ?? Infinity)) kept.set(photo.hash, photo);
  }
  return [...kept.values()];
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

/** Newest first; those with no date last. */
function newestFirst(photos: readonly Photo[], dateOf: PhotoDating): Array<{ photo: Photo; date: number | null }> {
  return photos
    .map((photo) => ({ photo, date: dateOf(photo) }))
    .sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity) || a.photo.name.localeCompare(b.photo.name) || a.photo.href.localeCompare(b.photo.href));
}

/** The photos newest first under their date headings; those with no date last. */
export function arrangePhotos(photos: readonly Photo[], dateOf: PhotoDating, now = new Date(), locale?: string): PhotoGroup[] {
  const groups: PhotoGroup[] = [];
  for (const { photo, date } of newestFirst(photos, dateOf)) {
    const heading = dateHeading(date, now, locale);
    const last = groups[groups.length - 1];
    if (last?.key === heading.key) last.photos.push(photo);
    else groups.push({ ...heading, photos: [photo] });
  }
  return groups;
}

export function albumKey(scope: string, path: string[]): string {
  return [scope, ...path].map(encodeURIComponent).join('/');
}

export function validAlbumName(name: string): boolean {
  return !!name.trim() && !name.includes('/') && name !== '.' && name !== '..'
    && !isHiddenDirectoryName(name) && !isDocumentFolderName(name);
}

/**
 * The folders that hold photos themselves, the one with the newest photo
 * first. The top of My Drive is no album; the top of a shared folder is.
 */
export function photoAlbums(photos: readonly Photo[], dateOf: PhotoDating, folders: readonly Album[] = []): Album[] {
  const albums = new Map<string, Album>();
  for (const { photo } of newestFirst(photos, dateOf)) {
    const path = photo.path.slice(0, -1);
    if (path.length === 0 && !photo.shared) continue;
    const key = albumKey(photo.scope, path);
    let album = albums.get(key);
    if (!album) {
      album = { key, scope: photo.scope, path, name: path[path.length - 1] ?? photo.label, photos: [] };
      albums.set(key, album);
    }
    album.photos.push(photo);
  }
  for (const folder of folders) {
    if (!albums.has(folder.key)) albums.set(folder.key, folder);
  }
  return [...albums.values()];
}

/** "1 photo", "12 photos"; "3 items" where there are videos too. */
export function countLabel(photos: readonly Photo[]): string {
  const count = photos.length;
  if (photos.some((photo) => photo.video)) return count === 1 ? '1 item' : `${count} items`;
  return count === 1 ? '1 photo' : `${count} photos`;
}

/**
 * What adding photos to a folder puts there, by their content: nothing for
 * one already there under any name, and a free name for one whose name a
 * different file has.
 */
export function albumAdditions(there: ReadonlyArray<{ name: string; cid: CID }>, photos: readonly Photo[]): Array<{ name: string; photo: Photo }> {
  const names = new Set(there.map((entry) => entry.name));
  const contents = new Set(there.map((entry) => toHex(entry.cid.hash)));
  const additions: Array<{ name: string; photo: Photo }> = [];
  for (const photo of photos) {
    if (contents.has(photo.hash)) continue;
    const name = freeName(photo.name, names);
    names.add(name);
    contents.add(photo.hash);
    additions.push({ name, photo });
  }
  return additions;
}

/** Which page of Photos a route path is: the timeline, the albums, or one album. */
export type PhotosPage =
  | { kind: 'timeline' }
  | { kind: 'albums' }
  | { kind: 'album'; scope: string; path: string[] };

export function photosPage(routePath: string): PhotosPage {
  const parts = routePath.split('/').filter(Boolean);
  if (parts[1] === 'albums') return { kind: 'albums' };
  if (parts[1] === 'album' && parts[2]) {
    const decode = (part: string) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    return { kind: 'album', scope: decode(parts[2]), path: parts.slice(3).map(decode) };
  }
  return { kind: 'timeline' };
}

export function albumHref(scope: string, path: string[]): string {
  return `#/photos/album/${albumKey(scope, path)}`;
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
