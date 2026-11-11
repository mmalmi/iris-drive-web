import { isDocumentFolderName, documentTitle } from '../lib/documentNames';
import type { NostrIdentityId } from './protocolTypes';
import type { AcceptedShareRecord } from './shareLibrary';

/** Session storage key for a join link opened before signing in. */
export const PENDING_JOIN_KEY = 'iris-drive.pending-join';

/** What the "invite people" part of the share dialog acts on. */
export type SharePeopleTarget =
  /** A folder or document of this Drive that is not shared yet. */
  | { kind: 'drive'; path: string[]; name: string }
  /** A shared folder, optionally opened at one of its documents. */
  | { kind: 'share'; shareId: NostrIdentityId; doc?: string };

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
  const doc = path.find((part) => isDocumentFolderName(part));
  if (scope !== profileId) {
    const record = records.find((item) => item.share_id === scope && item.local_profile_id === profileId);
    return record ? { kind: 'share', shareId: record.share_id, ...(doc ? { doc } : {}) } : null;
  }
  if (path.length === 0) return null;
  const owned = ownedShareAtPath(path, profileId, records);
  if (owned) return { kind: 'share', shareId: owned.record.share_id, ...(doc ? { doc } : {}) };
  // Inside a document's own folder there is nothing to share but the document.
  const docIndex = path.findIndex((part) => isDocumentFolderName(part));
  const target = docIndex >= 0 ? path.slice(0, docIndex + 1) : path;
  const last = target[target.length - 1]!;
  return { kind: 'drive', path: target, name: isDocumentFolderName(last) ? documentTitle(last) : last };
}
