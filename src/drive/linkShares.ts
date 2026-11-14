/**
 * General access by link for folders and documents of My Drive: "Anyone with
 * the link can view", or Public.
 *
 * The item is published as an ordinary hashtree tree under the key of the
 * device that turned it on: link-visible, with the link carrying the key that
 * opens it, or public. That device publishes each new version while Drive is
 * open on it, under the same name, so the link stays the same. The account's
 * other devices are told with one note each, readable only by them, so they
 * show the same setting.
 *
 * This file holds the records and what is decided from them; publishing is in
 * linkShareSync.ts.
 */
import type { Event } from 'nostr-tools';
import { writable } from 'svelte/store';
import { buildDeviceNotes, readDeviceNote } from './deviceNotes';
import { documentTitle, isDocumentFolderName } from '../lib/documentNames';

export type LinkAccess = 'link' | 'public';

export interface LinkShare {
  /** The account whose My Drive holds the item. */
  profile: string;
  /** The item's path in My Drive, such as `Trip` or `Plans/Budget.irissheet`. */
  path: string;
  /** The device that publishes it, and the tree it publishes it as. */
  npub: string;
  tree: string;
  /** Hex key the link carries; empty for a public one. */
  key: string;
  access: LinkAccess | 'off';
  /** When this was decided, in milliseconds: the latest decision about a tree wins. */
  at: number;
}

const STORAGE_KEY = 'iris-drive.link-shares';
/** Names the account's own Drive and the folders older accounts have under their key. */
const TAKEN_TREE_NAMES = new Set(['main', 'public', 'link', 'private']);

const sameTree = (a: LinkShare, b: LinkShare) => a.profile === b.profile && a.npub === b.npub && a.tree === b.tree;

function isLinkShare(value: unknown): value is LinkShare {
  const item = value as LinkShare;
  return !!item && typeof item === 'object'
    && typeof item.profile === 'string' && typeof item.path === 'string' && item.path !== ''
    && typeof item.npub === 'string' && item.npub.startsWith('npub1')
    && typeof item.tree === 'string' && item.tree !== ''
    && typeof item.key === 'string' && /^[0-9a-f]*$/.test(item.key)
    && (item.access === 'link' || item.access === 'public' || item.access === 'off')
    && (item.access !== 'link' || item.key !== '')
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

/** The link that opens the item, in force or not, at `path` of an account's My Drive. */
export function linkShareOf(path: string[], profile: string | null | undefined, records: LinkShare[]): LinkShare | null {
  const at = path.join('/');
  return records
    .filter((record) => record.profile === profile && record.path === at)
    .sort((a, b) => b.at - a.at)[0] ?? null;
}

/**
 * The link in force that opens the item at `path`: its own, or that of the
 * folder it is in, the nearest one first.
 */
export function linkShareCovering(path: string[], profile: string | null | undefined, records: LinkShare[]): LinkShare | null {
  for (let depth = path.length; depth > 0; depth -= 1) {
    const record = linkShareOf(path.slice(0, depth), profile, records);
    if (record && record.access !== 'off') return record;
  }
  return null;
}

/** The address people open, signed in or not. A document opens as itself. */
export function linkShareUrl(record: LinkShare, origin = 'https://drive.iris.to'): string {
  const name = record.path.split('/').at(-1) ?? '';
  const document = isDocumentFolderName(name) ? `/${encodeURIComponent(name)}` : '';
  const key = record.access === 'link' ? `?k=${record.key}` : '';
  return `${origin}/#/${record.npub}/${encodeURIComponent(record.tree)}${document}${key}`;
}

/** A name for a new link's tree: the item's own, unless this device already uses it for something else. */
export function linkTreeName(path: string[], npub: string, records: LinkShare[]): string {
  const name = path.at(-1) ?? 'Shared';
  const base = isDocumentFolderName(name) ? documentTitle(name) : name;
  const used = new Set(records.filter((record) => record.npub === npub && record.path !== path.join('/')).map((record) => record.tree));
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
