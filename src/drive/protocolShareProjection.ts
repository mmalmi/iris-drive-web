import type {
  NostrIdentityRosterProjection,
  ShareMember,
  ShareMemberRosterProjection,
  SharedFolder,
  SignedNostrIdentityRosterOp,
  SignedShareMemberRosterOp,
} from './protocolTypes';
import { projectNostrIdentityRoster } from './protocolProfileProjection';
import { signedShareMemberRosterOpIsValid } from './protocolShareValidation';
import { profileIdForAppKey, shareRoleRank } from './protocolShareBase';

export function projectSharedFolderMemberRoster(
  folder: SharedFolder,
  keyProjection = projectNostrIdentityRoster(folder.share_id, folder.roster_ops ?? []),
): ShareMemberRosterProjection {
  const projection: ShareMemberRosterProjection = {
    share_id: folder.share_id,
    members: {},
    accepted_op_ids: [],
    rejected_op_ids: [],
  };
  const sorted = (folder.member_ops ?? [])
    .filter((op) => op.content.share_id === folder.share_id)
    .slice()
    .sort((a, b) => (a.content.created_at - b.content.created_at) || a.op_id.localeCompare(b.op_id));
  const accepted = new Map<string, SignedShareMemberRosterOp>();
  for (const signed of sorted) {
    if (!signedShareMemberRosterOpIsValid(signed)) {
      projection.rejected_op_ids.push(signed.op_id);
      continue;
    }
    if (!applyShareMemberRosterOp(projection, folder, keyProjection, signed, accepted)) {
      projection.rejected_op_ids.push(signed.op_id);
      continue;
    }
    projection.accepted_op_ids.push(signed.op_id);
    accepted.set(signed.op_id, signed);
  }
  return projection;
}

export function applyShareMemberRosterOp(
  projection: ShareMemberRosterProjection,
  folder: SharedFolder,
  keyProjection: NostrIdentityRosterProjection,
  signed: SignedShareMemberRosterOp,
  accepted: Map<string, SignedShareMemberRosterOp>,
): boolean {
  if (!shareMemberSignerCanApply(projection, folder, keyProjection, signed, accepted)) return false;
  const op = signed.content.op;
  if (op.op === 'grant_member') {
    if (op.member.status === 'revoked') return false;
    mergeShareMemberGrant(projection.members, op.member);
    return true;
  }
  if (op.op === 'set_member_role') {
    const member = projection.members[op.profile_id];
    if (!member || member.status === 'revoked') return false;
    member.role = op.role;
    return true;
  }
  const member = projection.members[op.profile_id];
  if (!member) return false;
  member.status = 'revoked';
  return true;
}

export function shareMemberSignerCanApply(
  projection: ShareMemberRosterProjection,
  folder: SharedFolder,
  keyProjection: NostrIdentityRosterProjection,
  signed: SignedShareMemberRosterOp,
  accepted: Map<string, SignedShareMemberRosterOp>,
): boolean {
  const keyParentProjection = projectShareKeyRosterParentClosure(folder, keyProjection, signed);
  if (!keyParentProjection) return false;
  if (Object.keys(projection.members).length === 0) {
    return isValidShareMemberBootstrap(folder, keyParentProjection, signed);
  }
  const parents = signed.content.parents ?? [];
  if (parents.length === 0) return false;
  const parentProjection = projectShareMemberParentClosure(folder, keyProjection, parents, accepted);
  if (!parentProjection) return false;
  const signerProfileId = profileIdForAppKey(keyParentProjection, signed.signer_pubkey);
  const signerMember = signerProfileId ? parentProjection.members[signerProfileId] : undefined;
  const signerFacet = keyParentProjection.active_facets[signed.signer_pubkey];
  return Boolean(
    signerMember?.status === 'active'
    && signerMember.role === 'admin'
    && signerFacet?.capabilities?.can_admin_profile,
  );
}

export function projectShareKeyRosterParentClosure(
  folder: SharedFolder,
  keyProjection: NostrIdentityRosterProjection,
  signed: SignedShareMemberRosterOp,
): NostrIdentityRosterProjection | null {
  const parents = signed.content.key_roster_parents ?? [];
  if (parents.length === 0) return null;
  const accepted = new Set(keyProjection.accepted_op_ids);
  const opsById = new Map(
    (folder.roster_ops ?? [])
      .filter((op) => accepted.has(op.op_id))
      .map((op) => [op.op_id, op]),
  );
  const pending = parents.slice();
  const seen = new Set<string>();
  while (pending.length) {
    const parentId = pending.pop()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    const parent = opsById.get(parentId);
    if (!parent) return null;
    for (const grandparent of parent.content.parents ?? []) pending.push(grandparent);
  }
  const parentOps = Array.from(seen)
    .map((opId) => opsById.get(opId))
    .filter((op): op is SignedNostrIdentityRosterOp => Boolean(op));
  if (parentOps.length !== seen.size) return null;
  const parentProjection = projectNostrIdentityRoster(folder.share_id, parentOps);
  return parents.every((parent) => parentProjection.accepted_op_ids.includes(parent))
    ? parentProjection
    : null;
}

export function projectShareMemberParentClosure(
  folder: SharedFolder,
  keyProjection: NostrIdentityRosterProjection,
  parents: string[],
  accepted: Map<string, SignedShareMemberRosterOp>,
): ShareMemberRosterProjection | null {
  const pending = parents.slice();
  const seen = new Set<string>();
  while (pending.length) {
    const parentId = pending.pop()!;
    if (seen.has(parentId)) continue;
    seen.add(parentId);
    const parent = accepted.get(parentId);
    if (!parent) return null;
    for (const grandparent of parent.content.parents ?? []) pending.push(grandparent);
  }
  const parentFolder: SharedFolder = {
    ...folder,
    member_ops: Array.from(seen)
      .map((opId) => accepted.get(opId))
      .filter((op): op is SignedShareMemberRosterOp => Boolean(op)),
  };
  const parentProjection = projectSharedFolderMemberRoster(parentFolder, keyProjection);
  return parents.every((parent) => parentProjection.accepted_op_ids.includes(parent))
    ? parentProjection
    : null;
}

export function isValidShareMemberBootstrap(
  folder: SharedFolder,
  keyProjection: NostrIdentityRosterProjection,
  signed: SignedShareMemberRosterOp,
): boolean {
  const op = signed.content.op;
  if (op.op !== 'grant_member') return false;
  const signerProfileId = profileIdForAppKey(keyProjection, signed.signer_pubkey);
  return Boolean(
    op.member.profile_id === folder.owner_profile_id
    && op.member.role === 'admin'
    && op.member.status === 'active'
    && signerProfileId === folder.owner_profile_id
    && keyProjection.active_facets[signed.signer_pubkey]?.capabilities?.can_admin_profile,
  );
}

export function mergeShareMemberGrant(
  members: Record<string, ShareMember>,
  granted: ShareMember,
): void {
  const existing = members[granted.profile_id];
  if (!existing) {
    members[granted.profile_id] = { ...granted };
    return;
  }
  existing.role = shareRoleRank(existing.role) >= shareRoleRank(granted.role) ? existing.role : granted.role;
  if (existing.status === 'pending' && granted.status === 'active') existing.status = 'active';
  existing.representative_npub_hint ??= granted.representative_npub_hint;
  existing.display_name ??= granted.display_name;
}
