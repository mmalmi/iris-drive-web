import type {
  IrisProfileId,
  IrisProfileRosterProjection,
  ShareMember,
  ShareRootWriteAuthorization,
  SharedFolder,
  SharedFolderMemberView,
  SharedFolderView,
} from './protocolTypes';
import { projectIrisProfileRoster } from './protocolProfileProjection';
import { projectSharedFolderMemberRoster } from './protocolShareProjection';
import {
  profileIdForAppKey,
  shareMemberStatusLabel,
  shareParticipantProfiles,
  shareRoleLabel,
  shareRoleRank,
} from './protocolShareBase';

export function activeShareKeyRecipients(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
): string[] {
  return Object.values(projection.active_facets)
    .filter((facet) => facet.capabilities?.can_receive_key_wraps)
    .filter((facet) => activeMemberForAppKey(folder, projection, facet.pubkey))
    .map((facet) => facet.pubkey)
    .sort();
}

export function activeShareAppKeyPubkeys(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
): string[] {
  return Object.values(projection.active_facets)
    .filter((facet) => facet.purposes?.includes('app_key'))
    .filter((facet) => activeMemberForAppKey(folder, projection, facet.pubkey))
    .map((facet) => facet.pubkey)
    .sort();
}

export function tombstonedShareAppKeyPubkeys(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
): string[] {
  return Object.keys(projection.tombstones)
    .filter((pubkey) => Boolean(profileIdForAppKey(projection, pubkey)))
    .sort();
}

export function latestKeyEpoch(projection: IrisProfileRosterProjection): number | undefined {
  const epochs = Object.keys(projection.key_epochs).map((epoch) => Number(epoch));
  return epochs.length ? Math.max(...epochs) : undefined;
}

export function sharedFolderAppKeyWriteAuthorization(
  folder: SharedFolder,
  appKeyPubkey: string,
): ShareRootWriteAuthorization {
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  return sharedFolderAppKeyWriteAuthorizationWithProjection(folder, projection, appKeyPubkey);
}

export function sharedFolderAuthorizedWriterPubkeys(folder: SharedFolder): string[] {
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  return Object.keys(shareParticipantProfiles(projection))
    .filter((pubkey) => (
      sharedFolderAppKeyWriteAuthorizationWithProjection(folder, projection, pubkey) === 'authorized'
    ))
    .sort();
}

export function sharedFolderAppKeysForProfile(folder: SharedFolder, profileId: IrisProfileId): string[] {
  const projection = projectIrisProfileRoster(folder.share_id, folder.roster_ops ?? []);
  return Object.entries(shareParticipantProfiles(projection))
    .filter(([, participantProfileId]) => participantProfileId === profileId)
    .map(([appKeyPubkey]) => appKeyPubkey)
    .sort();
}



export function shareMembers(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
): Record<string, ShareMember> {
  if (!folder.member_ops?.length) return { ...(folder.members ?? {}) };
  return projectSharedFolderMemberRoster(folder, projection).members;
}

export function activeMemberForAppKey(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  appKeyPubkey: string,
): ShareMember | undefined {
  const profileId = profileIdForAppKey(projection, appKeyPubkey);
  if (!profileId) return undefined;
  const member = shareMembers(folder, projection)[profileId];
  return member?.status === 'active' ? member : undefined;
}

export function memberForAppKey(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  appKeyPubkey: string,
): ShareMember | undefined {
  const profileId = profileIdForAppKey(projection, appKeyPubkey);
  return profileId ? shareMembers(folder, projection)[profileId] : undefined;
}

export function sharedFolderAppKeyWriteAuthorizationWithProjection(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  appKeyPubkey: string,
): ShareRootWriteAuthorization {
  const profileId = profileIdForAppKey(projection, appKeyPubkey);
  if (!profileId) return 'unknown_app_key';
  const member = shareMembers(folder, projection)[profileId];
  if (!member) return 'unknown_member';
  if (member.status === 'pending') return 'pending_member';
  if (member.status === 'revoked') return 'revoked_member';
  if (shareRoleRank(member.role) < shareRoleRank('editor')) return 'insufficient_share_role';
  const facet = projection.active_facets[appKeyPubkey];
  if (!facet) return 'app_key_not_active';
  if (!facet.purposes?.includes('app_key')) return 'not_an_app_key';
  if (!facet.capabilities?.can_write_roots) return 'app_key_cannot_write_roots';
  return 'authorized';
}

export function sharedFolderAppKeyCanAdmin(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  appKeyPubkey: string,
): boolean {
  const member = activeMemberForAppKey(folder, projection, appKeyPubkey);
  const facet = projection.active_facets[appKeyPubkey];
  return Boolean(member?.role === 'admin' && facet?.capabilities?.can_admin_profile);
}

export function shareKeyStatus(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  appKeyPubkey: string,
  currentKeyEpoch: number | undefined,
  missing: string[],
): SharedFolderView['key_status'] {
  const member = memberForAppKey(folder, projection, appKeyPubkey);
  if (!member) return 'not_a_recipient';
  if (member.status === 'revoked') return 'revoked';
  if (member.status !== 'active') return 'not_a_recipient';
  if (currentKeyEpoch === undefined) return 'no_key_epoch';
  const facet = projection.active_facets[appKeyPubkey];
  if (!facet) return projection.tombstones[appKeyPubkey] ? 'revoked' : 'not_a_recipient';
  if (!facet.capabilities?.can_receive_key_wraps) return 'not_a_recipient';
  const epoch = projection.key_epochs[String(currentKeyEpoch)];
  if (!epoch) return 'no_key_epoch';
  if (epoch.wrapped_dck[appKeyPubkey]) return missing.length ? 'repair_needed' : 'available';
  return 'key_unavailable';
}

export function shareMemberViews(
  folder: SharedFolder,
  projection: IrisProfileRosterProjection,
  currentAppKeyPubkey = '',
  currentAppKeyCanAdmin = false,
): SharedFolderMemberView[] {
  const counts: Record<string, number> = {};
  for (const profileId of Object.values(shareParticipantProfiles(projection))) {
    counts[profileId] = (counts[profileId] ?? 0) + 1;
  }
  const currentProfileId = currentAppKeyPubkey ? profileIdForAppKey(projection, currentAppKeyPubkey) : null;
  return Object.values(shareMembers(folder, projection))
    .map((member) => ({
      profile_id: member.profile_id,
      role: member.role,
      role_label: shareRoleLabel(member.role),
      status: member.status,
      status_label: shareMemberStatusLabel(member.status),
      display_name: member.display_name || member.representative_npub_hint || member.profile_id,
      representative_npub_hint: member.representative_npub_hint,
      app_key_count: counts[member.profile_id] ?? 0,
      can_revoke: currentAppKeyCanAdmin && member.status !== 'revoked' && currentProfileId !== member.profile_id,
      can_change_role: currentAppKeyCanAdmin && member.status !== 'revoked' && currentProfileId !== member.profile_id,
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.profile_id.localeCompare(b.profile_id));
}
