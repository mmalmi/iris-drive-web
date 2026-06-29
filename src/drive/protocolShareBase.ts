import type {
  NostrIdentityId,
  NostrIdentityRosterProjection,
  ShareMemberStatus,
  ShareRole,
  ShareRootWriteAuthorization,
  SharedFolderView,
} from './protocolTypes';

export function profileIdForAppKey(
  projection: NostrIdentityRosterProjection,
  appKeyPubkey: string,
): NostrIdentityId | undefined {
  return projection.active_facets[appKeyPubkey]?.profile_id
    ?? projection.tombstones[appKeyPubkey]?.profile_id;
}

export function shareParticipantProfiles(
  projection: NostrIdentityRosterProjection,
): Record<string, NostrIdentityId> {
  const participantProfiles: Record<string, NostrIdentityId> = {};
  for (const [appKeyPubkey, facet] of Object.entries(projection.active_facets)) {
    if (facet.profile_id) participantProfiles[appKeyPubkey] = facet.profile_id;
  }
  for (const [appKeyPubkey, tombstone] of Object.entries(projection.tombstones)) {
    if (tombstone.profile_id) participantProfiles[appKeyPubkey] = tombstone.profile_id;
  }
  return participantProfiles;
}

export function shareRoleRank(role: ShareRole): number {
  return role === 'admin' ? 2 : role === 'editor' ? 1 : 0;
}

export function shareRoleLabel(role: ShareRole): string {
  return role === 'admin' ? 'Admin' : role === 'editor' ? 'Editor' : 'Reader';
}

export function shareMemberStatusLabel(status: ShareMemberStatus): string {
  return status === 'active' ? 'Active' : status === 'pending' ? 'Pending' : 'Revoked';
}

export function shareRootWriteAuthorizationLabel(status: ShareRootWriteAuthorization): string {
  switch (status) {
    case 'authorized':
      return 'Authorized';
    case 'unknown_app_key':
      return 'Unknown AppKey';
    case 'unknown_member':
      return 'Unknown member';
    case 'pending_member':
      return 'Pending member';
    case 'revoked_member':
      return 'Revoked member';
    case 'insufficient_share_role':
      return 'Insufficient share role';
    case 'app_key_not_active':
      return 'AppKey not active';
    case 'not_an_app_key':
      return 'Not an AppKey';
    case 'app_key_cannot_write_roots':
      return 'AppKey cannot write roots';
  }
}

export function shareKeyStatusLabel(status: SharedFolderView['key_status']): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'repair_needed':
      return 'Repair needed';
    case 'key_unavailable':
      return 'Key unavailable';
    case 'no_key_epoch':
      return 'No key epoch';
    case 'not_a_recipient':
      return 'Not a recipient';
    case 'revoked':
      return 'Revoked';
  }
}

export function sanitizeProviderName(value: string): string {
  const sanitized = value.trim().replace(/[\\/]/g, '_').replace(/^\.+$/, 'Shared folder');
  return sanitized || 'Shared folder';
}
