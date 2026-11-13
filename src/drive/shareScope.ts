import { get } from 'svelte/store';
import { getCurrentNostrIdentitySession } from '../nostr/auth';
import { acceptedShares, isOwnShare, type AcceptedShareRecord } from './shareLibrary';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { sharedFolderAuthorizedWriterPubkeys, sharedFolderKeyRecipientPubkeys } from './protocol';
import { driveRootPath } from './setup';

/**
 * Where a shared folder is reached from, outermost first: My Drive and the
 * folders above it for one this profile shared, Shared with me for others'.
 */
export function shareLocation(record: Pick<AcceptedShareRecord, 'folder' | 'local_profile_id'>): { name: string; href: string }[] {
  if (!isOwnShare(record)) return [{ name: 'Shared with me', href: '#/shared-with-me' }];
  const root = `#${driveRootPath(record.local_profile_id)}`;
  const above = (record.folder.source_path ?? '').split('/').filter(Boolean).slice(0, -1);
  return [
    { name: 'My Drive', href: root },
    ...above.map((name, depth) => ({
      name,
      href: `${root}/${above.slice(0, depth + 1).map(encodeURIComponent).join('/')}`,
    })),
  ];
}

export function activeShareScope(
  scope: string | null | undefined,
  state?: { isLoggedIn: boolean; pubkey: string | null },
  records: AcceptedShareRecord[] = get(acceptedShares),
) {
  const session = getCurrentNostrIdentitySession();
  if (!scope || !session || session.status !== 'active'
    || (state && (!state.isLoggedIn || state.pubkey !== session.appKeyPubkey))) return null;
  const record = records.find((item) => item.share_id === scope && item.local_profile_id === session.profileId);
  if (!record) return null;
  const projection = projectSharedFolderKeys(record.folder);
  const facet = projection.active_facets[session.appKeyPubkey];
  if (!facet?.capabilities?.can_decrypt_secret_epochs) return null;
  return {
    record,
    canWrite: facet.capabilities.can_write_roots,
    writers: sharedFolderAuthorizedWriterPubkeys(record.folder),
    recipients: sharedFolderKeyRecipientPubkeys(record.folder),
    epoch: Math.max(0, ...Object.keys(projection.secret_epochs).map(Number)),
  };
}
