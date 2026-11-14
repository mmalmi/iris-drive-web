import { isDocumentFolderName, documentTitle } from '../lib/documentNames';
import type { NostrIdentityId } from './protocolTypes';
import type { AcceptedShareRecord } from './shareLibrary';

/** Session storage key for a join link opened before signing in. */
export const PENDING_JOIN_KEY = 'iris-drive.pending-join';
/** Session storage key for the address of a shared folder opened before signing in. */
export const PENDING_OPEN_KEY = 'iris-drive.pending-open';

/** What the "invite people" part of the share dialog acts on. */
export type SharePeopleTarget =
  /** A folder or document of this Drive that is not shared yet. */
  | { kind: 'drive'; path: string[]; name: string }
  /**
   * A shared folder, optionally opened at one of its documents: `doc` is its
   * name, `docPath` its path inside the shared folder.
   */
  | { kind: 'share'; shareId: NostrIdentityId; doc?: string; docPath?: string[] };

/** The shared folder this profile owns at a path of its own Drive, or that contains the path. */
export function ownedShareAtPath(
  path: string[],
  profileId: NostrIdentityId | null | undefined,
  records: AcceptedShareRecord[],
): { record: AcceptedShareRecord; rest: string[] } | null {
  if (!profileId || path.length === 0) return null;
  const joined = path.join('/');
  for (const record of records) {
    if (record.local_profile_id !== profileId || record.folder.owner_profile_id !== profileId) continue;
    const source = record.folder.source_path;
    if (!source || (joined !== source && !joined.startsWith(`${source}/`))) continue;
    const sourceParts = source.split('/');
    const rest = path.slice(sourceParts.length);
    const sourceName = sourceParts[sourceParts.length - 1]!;
    // A shared document keeps its own name inside the shared folder.
    return { record, rest: isDocumentFolderName(sourceName) ? [sourceName, ...rest] : rest };
  }
  return null;
}

/**
 * Where an item of a folder this profile shared from its own Drive is in that
 * Drive: the way back from `ownedShareAtPath`. Null when the folder is not
 * this profile's, or the item was added beside a shared document.
 */
export function ownDrivePathInShare(record: AcceptedShareRecord, inner: string[]): string[] | null {
  const source = record.folder.source_path;
  if (record.folder.owner_profile_id !== record.local_profile_id || !source) return null;
  const sourceParts = source.split('/');
  const sourceName = sourceParts[sourceParts.length - 1]!;
  if (!isDocumentFolderName(sourceName)) return [...sourceParts, ...inner];
  // A shared document is in the shared folder under its own name.
  if (inner.length === 0) return sourceParts;
  return inner[0] === sourceName ? [...sourceParts.slice(0, -1), ...inner] : null;
}

/**
 * Where a page of this profile's own Drive really lives once it has been
 * shared: the same place inside the shared folder, so the owner edits what
 * everyone else sees.
 */
export function sharedRouteForOwnPath(
  path: string[],
  profileId: NostrIdentityId | null | undefined,
  records: AcceptedShareRecord[],
): string | null {
  const owned = ownedShareAtPath(path, profileId, records);
  if (!owned) return null;
  return `/${[owned.record.share_id, 'main', ...owned.rest].map(encodeURIComponent).join('/')}`;
}

export function sharePeopleTarget(options: {
  scope: string | null | undefined;
  treeName: string | null | undefined;
  path: string[];
  profileId: NostrIdentityId | null | undefined;
  records: AcceptedShareRecord[];
}): SharePeopleTarget | null {
  const { scope, treeName, path, profileId, records } = options;
  if (!scope || !profileId || treeName !== 'main') return null;
  const inShare = (shareId: NostrIdentityId, inner: string[]): SharePeopleTarget => {
    const docIndex = inner.findIndex((part) => isDocumentFolderName(part));
    return docIndex < 0
      ? { kind: 'share', shareId }
      : { kind: 'share', shareId, doc: inner[docIndex]!, docPath: inner.slice(0, docIndex + 1) };
  };
  if (scope !== profileId) {
    const record = records.find((item) => item.share_id === scope && item.local_profile_id === profileId);
    return record ? inShare(record.share_id, path) : null;
  }
  if (path.length === 0) return null;
  const owned = ownedShareAtPath(path, profileId, records);
  if (owned) return inShare(owned.record.share_id, owned.rest);
  // Inside a document's own folder there is nothing to share but the document.
  const docIndex = path.findIndex((part) => isDocumentFolderName(part));
  const target = docIndex >= 0 ? path.slice(0, docIndex + 1) : path;
  const last = target[target.length - 1]!;
  return { kind: 'drive', path: target, name: isDocumentFolderName(last) ? documentTitle(last) : last };
}
