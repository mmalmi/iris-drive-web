import { get } from 'svelte/store';
import { getCurrentNostrIdentitySession } from '../nostr/auth';
import { acceptedShares, type AcceptedShareRecord } from './shareLibrary';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { sharedFolderAuthorizedWriterPubkeys, sharedFolderKeyRecipientPubkeys } from './protocol';

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
