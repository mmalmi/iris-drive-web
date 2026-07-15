import type { NostrIdentityId, ShareInviteBundle, SharedFolder } from './protocolTypes';
import { SHARE_INVITE_PREFIX } from './protocolTypes';
import { base64UrlEncode } from './protocolJson';
import { validateSignedNostrIdentityRosterOps } from './protocolProfileValidation';
import { projectNostrIdentityRoster } from './protocolProfileProjection';
import { validateShareRosterCheckpoint } from './protocolShareEvents';
import { shareMembers } from './protocolShareAccess';
import { validateSignedShareMemberRosterOps } from './protocolShareValidation';

export function parseShareInvite(input: string): ShareInviteBundle {
  const trimmed = input.trim();
  const encoded = trimmed.startsWith(SHARE_INVITE_PREFIX)
    ? trimmed.slice(SHARE_INVITE_PREFIX.length)
    : trimmed;
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64);
  const json = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  const parsed = JSON.parse(json) as ShareInviteBundle;
  if (parsed.schema !== 1) {
    throw new Error(`unsupported share invite schema ${parsed.schema}`);
  }
  validateSignedNostrIdentityRosterOps(parsed.shared_folder);
  validateSignedShareMemberRosterOps(parsed.shared_folder);
  if (parsed.roster_checkpoint) {
    validateShareRosterCheckpoint(parsed.shared_folder, parsed.roster_checkpoint);
  }
  return parsed;
}

export function encodeShareInvite(bundle: ShareInviteBundle): string {
  if (bundle.schema !== 1) {
    throw new Error(`unsupported share invite schema ${bundle.schema}`);
  }
  return `${SHARE_INVITE_PREFIX}${base64UrlEncode(new TextEncoder().encode(JSON.stringify(bundle)))}`;
}

export function sharedFolderFromInviteForProfile(
  invite: string,
  localProfileId: NostrIdentityId,
): SharedFolder {
  const bundle = parseShareInvite(invite);
  if (!shareInviteBundleIncludesProfile(bundle, localProfileId)) {
    throw new Error(`share invite is not for NostrIdentity ${localProfileId}`);
  }
  return bundle.shared_folder;
}

export function shareInviteBundleIncludesProfile(
  bundle: ShareInviteBundle,
  localProfileId: NostrIdentityId,
): boolean {
  const projection = projectNostrIdentityRoster(
    bundle.shared_folder.share_id,
    bundle.shared_folder.roster_ops ?? [],
  );
  const members = shareMembers(bundle.shared_folder, projection);
  return bundle.recipient_profile_id === localProfileId && Boolean(members[localProfileId]);
}
