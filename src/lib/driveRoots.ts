/**
 * The trees that make up the person's own Drive: My Drive and the shared
 * folders this device holds, as far as this device has them now.
 */
import type { AcceptedShareRecord } from '../drive/shareLibrary';
import { getTreeRootSync } from '../stores/treeRoot';
import type { DriveRoot } from './driveWalk';

/** The scopes whose trees make up this Drive: My Drive's first, then each shared folder's. */
export function driveScopes(ownProfileId: string | null, npub: string | null, records: AcceptedShareRecord[]): string[] {
  const scope = ownProfileId ?? npub;
  return [...(scope ? [scope] : []), ...ownShares(ownProfileId, records).map((record) => record.share_id)];
}

function ownShares(ownProfileId: string | null, records: AcceptedShareRecord[]): AcceptedShareRecord[] {
  return records.filter((record) => !ownProfileId || record.local_profile_id === ownProfileId);
}

export function driveRoots(ownProfileId: string | null, npub: string | null, records: AcceptedShareRecord[]): DriveRoot[] {
  const scope = ownProfileId ?? npub;
  const shares = ownShares(ownProfileId, records);
  const roots: DriveRoot[] = [];
  const ownCid = scope ? getTreeRootSync(scope, 'main') : null;
  if (scope && ownCid) {
    const sharedOut = shares
      .filter((record) => record.folder.owner_profile_id === ownProfileId && record.folder.source_path)
      .map((record) => record.folder.source_path);
    roots.push({ scope, label: 'My Drive', cid: ownCid, skip: sharedOut });
  }
  for (const record of shares) {
    const cid = getTreeRootSync(record.share_id, 'main');
    if (cid) roots.push({ scope: record.share_id, label: record.folder.display_name, cid, shared: true });
  }
  return roots;
}
