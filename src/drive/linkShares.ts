/**
 * General access by link for folders, documents and files: "Anyone with the
 * link can view", or Public.
 *
 * The item is published as an ordinary hashtree tree under the key of the
 * device that turned it on: link-visible, with the link carrying the key that
 * opens it, or public. That device publishes each new version while Drive is
 * open on it, under the same name, so the link stays the same. The account's
 * other devices are told with one note each, readable only by them, so they
 * show the same setting.
 *
 * An item is named by its path in My Drive, also once it is shared with
 * people, so its link and key outlive sharing with people; its newest version
 * is then the shared folder's. An item of a folder shared from someone else's
 * Drive is named by the shared folder and its path there. The people a folder
 * is shared with are told whether it opens by link, never the link itself.
 *
 * This file holds the records and what is decided from them; publishing is in
 * linkShareSync.ts.
 */
import { nip19, type Event } from 'nostr-tools';
import { writable } from 'svelte/store';
import { buildDeviceNotes, readDeviceNote } from './deviceNotes';
import { documentTitle, isDocumentFolderName } from '../lib/documentNames';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { sharedFolderAppKeyCanAdmin } from './protocolShareAccess';
import { ownDrivePathInShare, ownedShareAtPath } from './sharePeople';
import type { AcceptedShareRecord } from './shareLibrary';

export type LinkAccess = 'link' | 'public';

export interface LinkShare {
  /** The account that decided it. */
  profile: string;
  /**
   * The item's path in My Drive, such as `Trip` or `Plans/Budget.irissheet`;
   * with `share`, its path in that shared folder, empty for all of it.
   */
  path: string;
  /** The shared folder the item is in, when it is not named by a path in My Drive. */
  share?: string;
  /** A single file, which the link opens as itself. */
  file?: boolean;
  /** The device that publishes it, and the tree it publishes it as. */
  npub: string;
  tree: string;
  /** Hex key the link carries; empty for a public one, and where it is only known that the link is on. */
  key: string;
  access: LinkAccess | 'off';
  /** When this was decided, in milliseconds: the latest decision about a tree wins. */
  at: number;
}

/** What General access is set on: an item named by its path in My Drive, or in a shared folder. */
export interface LinkSubject {
  path: string[];
  share?: string;
}

/** Where sharing was opened: My Drive (the profile's own id) or a shared folder, and the item's path there. */
export interface LinkTarget {
  scope: string;
  path: string[];
}

const STORAGE_KEY = 'iris-drive.link-shares';
/** Names the account's own Drive and the folders older accounts have under their key. */
const TAKEN_TREE_NAMES = new Set(['main', 'public', 'link', 'private']);

const sameTree = (a: LinkShare, b: LinkShare) => a.profile === b.profile && a.npub === b.npub && a.tree === b.tree;

function isLinkShare(value: unknown): value is LinkShare {
  const item = value as LinkShare;
  return !!item && typeof item === 'object'
    && typeof item.profile === 'string' && typeof item.path === 'string'
    && (item.share === undefined ? item.path !== '' : typeof item.share === 'string' && item.share !== '')
    && (item.file === undefined || typeof item.file === 'boolean')
    && typeof item.npub === 'string' && item.npub.startsWith('npub1')
    && typeof item.tree === 'string' && item.tree !== ''
    && typeof item.key === 'string' && /^[0-9a-f]*$/.test(item.key)
    && (item.access === 'link' || item.access === 'public' || item.access === 'off')
    && (item.access !== 'link' || item.key !== '' || item.share !== undefined)
    && typeof item.at === 'number' && Number.isFinite(item.at);
}

/** The records with `incoming` taken in: for each tree, the latest decision. */
export function mergeLinkShares(records: LinkShare[], incoming: LinkShare[]): LinkShare[] {
  let merged = records;
  for (const record of incoming) {
    const index = merged.findIndex((item) => sameTree(item, record));
    if (index < 0) merged = [...merged, record];
    else if (record.at > merged[index]!.at) merged = merged.map((item, i) => (i === index ? record : item));
  }
  return merged;
}

/**
 * Where General access for the item at `path` of the place being browsed is
 * set: My Drive, or a shared folder this profile is in; null elsewhere.
 */
export function linkTargetAt(options: {
  scope: string | null | undefined;
  treeName: string | null | undefined;
  path: string[];
  profileId: string | null | undefined;
  records: AcceptedShareRecord[];
}): LinkTarget | null {
  const { scope, treeName, path, profileId, records } = options;
  if (!scope || !profileId || treeName !== 'main' || path.length === 0) return null;
  const known = scope === profileId || records.some((item) => item.share_id === scope && item.local_profile_id === profileId);
  return known ? { scope, path } : null;
}

function shareOf(target: LinkTarget, profile: string, shares: AcceptedShareRecord[]): AcceptedShareRecord | null {
  return shares.find((item) => item.share_id === target.scope && item.local_profile_id === profile) ?? null;
}

/**
 * What General access at `target` is set on for the signed-in profile: in a
 * folder it shared from My Drive, the item's place in My Drive. Null where
 * there is none.
 */
export function linkSubjectAt(target: LinkTarget, profile: string | null | undefined, shares: AcceptedShareRecord[]): LinkSubject | null {
  if (!profile) return null;
  if (target.scope === profile) return target.path.length > 0 ? { path: target.path } : null;
  const record = shareOf(target, profile, shares);
  if (!record) return null;
  const own = ownDrivePathInShare(record, target.path);
  return own ? { path: own } : { path: target.path, share: record.share_id };
}

/** Whether this device can change General access at `target`: in its own Drive, or as an admin of the shared folder. */
export function canSetLinkAccess(
  target: LinkTarget,
  profile: string | null | undefined,
  devicePubkey: string | null | undefined,
  shares: AcceptedShareRecord[],
): boolean {
  if (!profile || !devicePubkey) return false;
  if (target.scope === profile) return target.path.length > 0;
  const record = shareOf(target, profile, shares);
  return !!record && sharedFolderAppKeyCanAdmin(record.folder, projectSharedFolderKeys(record.folder), devicePubkey);
}

/**
 * Where the newest version of a link's item is: the shared folder it is in
 * now, or My Drive. `scope` is that folder's id or the profile's.
 */
export function linkSource(
  record: Pick<LinkShare, 'profile' | 'path' | 'share'>,
  shares: AcceptedShareRecord[],
): { scope: string; path: string[] } {
  const path = record.path ? record.path.split('/') : [];
  if (record.share) return { scope: record.share, path };
  const owned = ownedShareAtPath(path, record.profile, shares);
  return owned ? { scope: owned.record.share_id, path: owned.rest } : { scope: record.profile, path };
}

function about(record: LinkShare, path: string, profile: string | null | undefined, share: string | undefined): boolean {
  return record.path === path && (share ? record.share === share : !record.share && record.profile === profile);
}

/**
 * The link, in force or not, that opens the item at `path` of an account's
 * My Drive; with `share`, at `path` of that shared folder, whoever made it.
 */
export function linkShareOf(path: string[], profile: string | null | undefined, records: LinkShare[], share?: string): LinkShare | null {
  const at = path.join('/');
  return records
    .filter((record) => about(record, at, profile, share))
    .sort((a, b) => b.at - a.at)[0] ?? null;
}

/**
 * The link in force that opens the item at `path`: its own, or that of the
 * folder it is in, the nearest one first.
 */
export function linkShareCovering(path: string[], profile: string | null | undefined, records: LinkShare[], share?: string): LinkShare | null {
  for (let depth = path.length; depth >= (share ? 0 : 1); depth -= 1) {
    const record = linkShareOf(path.slice(0, depth), profile, records, share);
    if (record && record.access !== 'off') return record;
  }
  return null;
}

/**
 * The address that opens the item at `target` by link, signed in or not:
 * its own link, or that of the folder it is in. Null when none is on.
 */
export function linkOpening(
  target: LinkTarget,
  profile: string | null | undefined,
  shares: AcceptedShareRecord[],
  records: LinkShare[],
): string | null {
  const subject = linkSubjectAt(target, profile, shares);
  if (!subject) return null;
  const record = linkShareCovering(subject.path, profile, records, subject.share);
  if (!record || (record.access !== 'public' && !record.key)) return null;
  const inside = subject.path.slice(record.path ? record.path.split('/').length : 0);
  return linkShareUrl(record, undefined, inside);
}

/**
 * The address people open, signed in or not. A document or a file opens as
 * itself; `inside` opens something inside a linked folder.
 */
export function linkShareUrl(record: LinkShare, origin = 'https://drive.iris.to', inside: string[] = []): string {
  const name = record.path.split('/').at(-1) ?? '';
  const own = name && (record.file || isDocumentFolderName(name)) ? [name] : [];
  const path = [record.tree, ...own, ...inside].map(encodeURIComponent).join('/');
  const key = record.access === 'link' ? `?k=${record.key}` : '';
  return `${origin}/#/${record.npub}/${path}${key}`;
}

/**
 * A name for a new link's tree: the item's own (`fallback` for a whole
 * shared folder), unless this device already uses it for something else.
 */
export function linkTreeName(subject: LinkSubject, npub: string, records: LinkShare[], fallback = 'Shared'): string {
  const name = subject.path.at(-1) || fallback;
  const base = isDocumentFolderName(name) ? documentTitle(name) : name;
  const at = subject.path.join('/');
  const used = new Set(records
    .filter((record) => record.npub === npub && !(record.path === at && record.share === subject.share))
    .map((record) => record.tree));
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    if (!used.has(candidate) && !TAKEN_TREE_NAMES.has(candidate.toLowerCase())) return candidate;
  }
}

function loadLinkShares(): LinkShare[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter(isLinkShare) : [];
  } catch {
    return [];
  }
}

export const linkShares = writable<LinkShare[]>(typeof localStorage === 'undefined' ? [] : loadLinkShares());
linkShares.subscribe((records) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Kept for this visit only.
  }
});

/** Tells one device of the account about a link; a later note about the same tree replaces it. */
export const LINK_SHARE_LABEL = 'iris-drive/link-share';
/** Tells one device of a person a folder is shared with whether an item of it opens by link. */
export const SHARE_LINK_LABEL = 'iris-drive/share-link';

/** One note per device, readable only by it: relays see a label and the device it is for. */
export function buildLinkShareNotes(signerSecretKey: Uint8Array, record: LinkShare, devicePubkeys: string[], createdAt: number): Event[] {
  return buildDeviceNotes(signerSecretKey, LINK_SHARE_LABEL, [record.profile, record.npub, record.tree], record, devicePubkeys, createdAt);
}

/**
 * The record a note carries, when it is for this device, comes from a device
 * of the same account and is about that account's Drive; otherwise null.
 */
export function readLinkShareNote(
  event: Event,
  deviceSecretKey: Uint8Array,
  account: { profile: string; devices: ReadonlySet<string> },
): LinkShare | null {
  if (!account.devices.has(event.pubkey)) return null;
  const record = readDeviceNote(event, LINK_SHARE_LABEL, deviceSecretKey)?.payload;
  return isLinkShare(record) && record.profile === account.profile ? record : null;
}

/**
 * Notes for the devices of the people a folder is shared with: whether the
 * item at `inner` of the shared folder opens by link, without the link's key.
 */
export function buildShareLinkNotes(
  signerSecretKey: Uint8Array,
  record: LinkShare,
  source: { share: string; inner: string[] },
  devicePubkeys: string[],
  createdAt: number,
): Event[] {
  const told: LinkShare = { ...record, share: source.share, path: source.inner.join('/'), key: '' };
  return buildDeviceNotes(signerSecretKey, SHARE_LINK_LABEL, [source.share, record.npub, record.tree], told, devicePubkeys, createdAt);
}

/**
 * What a note from an admin of a shared folder this profile is in says about
 * an item of it; null when the note is not that.
 */
export function readShareLinkNote(
  event: Event,
  deviceSecretKey: Uint8Array,
  profile: string,
  shares: AcceptedShareRecord[],
): LinkShare | null {
  const record = readDeviceNote(event, SHARE_LINK_LABEL, deviceSecretKey)?.payload;
  if (!isLinkShare(record) || !record.share || record.npub !== nip19.npubEncode(event.pubkey)) return null;
  const share = shares.find((item) => item.share_id === record.share && item.local_profile_id === profile);
  if (!share || !sharedFolderAppKeyCanAdmin(share.folder, projectSharedFolderKeys(share.folder), event.pubkey)) return null;
  return { ...record, key: '' };
}
