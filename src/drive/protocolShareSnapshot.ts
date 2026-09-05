import type { NostrIdentityRosterProjection, ShareAccessSnapshot, ShareMember, SharedFolder } from './protocolTypes';
import { projectNostrIdentityRoster } from './protocolProfileProjection';
import { shareRoleRank } from './protocolShareBase';

export function snapshotMembers(access: ShareAccessSnapshot): Record<string, ShareMember> {
  const members: Record<string, ShareMember> = {};
  for (const grant of access.grants ?? []) {
    if (grant.target.type !== 'id') continue;
    const profileId = grant.target.id;
    const existing = members[profileId];
    if (!existing) {
      members[profileId] = {
        profile_id: profileId, role: grant.role, status: grant.status,
        representative_npub_hint: grant.representative_npub_hint, display_name: grant.display_name,
      };
    } else {
      if (shareRoleRank(grant.role) > shareRoleRank(existing.role)) existing.role = grant.role;
      if (existing.status === 'pending' && grant.status === 'active') existing.status = 'active';
      existing.display_name ??= grant.display_name;
      existing.representative_npub_hint ??= grant.representative_npub_hint;
    }
  }
  return members;
}

export function activeDirectGrant(folder: SharedFolder, pubkey: string) {
  return folder.access?.grants?.find((grant) => grant.target.type === 'pubkey'
    && grant.target.pubkey === pubkey && grant.status === 'active');
}

/** Current native shares use access snapshots; legacy shares use signed roster operations. */
export function projectSharedFolderKeys(folder: SharedFolder): NostrIdentityRosterProjection {
  const access = folder.access;
  if (!access) return projectNostrIdentityRoster(folder.share_id, folder.roster_ops ?? []);
  const members = snapshotMembers(access);
  const projection: NostrIdentityRosterProjection = {
    profile_id: access.resource_id, active_facets: {}, tombstones: access.tombstones ?? {},
    secret_epochs: access.key_epochs ?? {}, accepted_op_ids: [], rejected_op_ids: [],
  };
  for (const [pubkey, device] of Object.entries(access.devices ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (projection.tombstones[pubkey]) continue;
    const member = device.profile_id ? members[device.profile_id] : undefined;
    const roles = (access.grants ?? []).filter((grant) => grant.target.type === 'pubkey'
      && grant.target.pubkey === pubkey && grant.status === 'active').map((grant) => grant.role);
    if (member?.status === 'active') roles.push(member.role);
    const role = roles.sort((a, b) => shareRoleRank(b) - shareRoleRank(a))[0];
    if (!role) continue;
    projection.active_facets[pubkey] = {
      ...device, purposes: ['app_key'], capabilities: {
        can_write_roots: role !== 'reader', can_admin_profile: role === 'admin',
        can_receive_secret_wraps: true, can_decrypt_secret_epochs: true,
      },
    };
  }
  return projection;
}
