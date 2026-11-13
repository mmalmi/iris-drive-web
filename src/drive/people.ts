import { nip19 } from 'nostr-tools';
import { isNostrIdentityId } from '../utils/route';
import { isDocumentFolderName } from '../lib/documentNames';
import type { NostrIdentityId, SharedFolder } from './protocol';
import type { AcceptedShareRecord } from './shareLibrary';

/**
 * The people Drive knows are the members of the shared folders this device
 * holds. Everything here reads those records; nothing waits for a relay.
 */

export function npubPubkey(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub' ? decoded.data : null;
  } catch {
    return null;
  }
}

function pubkeyNpub(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

function grantFor(folder: SharedFolder, profileId: NostrIdentityId) {
  return folder.access?.grants?.find((grant) => grant.target.type === 'id' && grant.target.id === profileId);
}

/** The npub a member goes by: the one they gave when added, otherwise their first device's. */
export function memberNpub(folder: SharedFolder, profileId: NostrIdentityId): string | null {
  const hint = grantFor(folder, profileId)?.representative_npub_hint;
  if (hint && npubPubkey(hint)) return hint;
  const device = Object.values(folder.access?.devices ?? {})
    .filter((item) => item.profile_id === profileId)
    .sort((a, b) => a.added_at - b.added_at || a.pubkey.localeCompare(b.pubkey))[0];
  return device ? pubkeyNpub(device.pubkey) : null;
}

/** Where a member's page is. */
export function personHref(folder: SharedFolder, profileId: NostrIdentityId): string {
  const npub = memberNpub(folder, profileId);
  return npub ? `#/${npub}/profile` : `#/${profileId}`;
}

/** A shared folder opens at its own root; a shared document opens the document. */
export function sharedItemHref(shareId: string, sourcePath: string | undefined): string {
  const name = sourcePath?.split('/').at(-1);
  return `#/${shareId}/main${name && isDocumentFolderName(name) ? `/${encodeURIComponent(name)}` : ''}`;
}

export interface PersonOverview {
  npub: string | null;
  /** The name the person gave in a shared folder, if any folder here has one. */
  name: string;
  sharedWithYou: AcceptedShareRecord[];
  youShare: AcceptedShareRecord[];
}

/** What this device knows about the person at a page address: an npub or a Drive profile id. */
export function personOverview(
  id: string,
  records: AcceptedShareRecord[],
  ownProfileId: NostrIdentityId | null,
): PersonOverview {
  const own = records.filter((record) => !ownProfileId || record.local_profile_id === ownProfileId);
  const pubkey = isNostrIdentityId(id) ? null : npubPubkey(id);
  const profileIds = new Set<string>();
  if (isNostrIdentityId(id)) profileIds.add(id);
  for (const { folder } of own) {
    for (const grant of folder.access?.grants ?? []) {
      if (grant.target.type === 'id' && grant.representative_npub_hint === id) profileIds.add(grant.target.id);
    }
    const device = pubkey ? folder.access?.devices?.[pubkey] : undefined;
    if (device?.profile_id) profileIds.add(device.profile_id);
  }
  if (ownProfileId) profileIds.delete(ownProfileId);

  let npub = pubkey ? id : null;
  let name = '';
  let nameAt = -1;
  for (const { folder } of own) {
    for (const profileId of profileIds) {
      const grant = grantFor(folder, profileId);
      if (!grant) continue;
      npub ??= memberNpub(folder, profileId);
      const updatedAt = folder.access?.updated_at ?? 0;
      if (grant.display_name?.trim() && updatedAt > nameAt) {
        name = grant.display_name.trim();
        nameAt = updatedAt;
      }
    }
  }

  const byName = (a: AcceptedShareRecord, b: AcceptedShareRecord) => a.folder.display_name.localeCompare(b.folder.display_name);
  return {
    npub,
    name,
    sharedWithYou: own
      .filter((record) => profileIds.has(record.folder.owner_profile_id))
      .sort(byName),
    youShare: own
      .filter((record) => record.folder.owner_profile_id === ownProfileId
        && [...profileIds].some((profileId) => grantFor(record.folder, profileId)?.status === 'active'))
      .sort(byName),
  };
}
