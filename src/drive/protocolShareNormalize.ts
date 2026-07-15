import type { ShareMember, ShareMemberRosterOp, ShareMemberRosterOpContent } from './protocolTypes';

export function normalizeShareMemberRosterOpContent(
  content: ShareMemberRosterOpContent,
): ShareMemberRosterOpContent {
  return {
    schema: content.schema,
    share_id: content.share_id,
    actor_pubkey: content.actor_pubkey,
    ...(content.parents?.length ? { parents: content.parents.slice() } : {}),
    ...(content.key_roster_parents?.length
      ? { key_roster_parents: content.key_roster_parents.slice() }
      : {}),
    client_nonce: content.client_nonce,
    created_at: content.created_at,
    op: normalizeShareMemberRosterOp(content.op),
  };
}

export function normalizeShareMemberRosterOp(op: ShareMemberRosterOp): ShareMemberRosterOp {
  if (op.op === 'grant_member') {
    return {
      op: 'grant_member',
      member: normalizeShareMember(op.member),
    };
  }
  if (op.op === 'set_member_role') {
    return {
      op: 'set_member_role',
      profile_id: op.profile_id,
      role: op.role,
    };
  }
  return {
    op: 'revoke_member',
    profile_id: op.profile_id,
    ...(op.reason !== undefined ? { reason: op.reason } : {}),
  };
}

export function normalizeShareMember(member: ShareMember): ShareMember {
  return {
    profile_id: member.profile_id,
    role: member.role,
    status: member.status,
    ...(member.representative_npub_hint !== undefined
      ? { representative_npub_hint: member.representative_npub_hint }
      : {}),
    ...(member.display_name !== undefined ? { display_name: member.display_name } : {}),
  };
}

export function validateShareMemberRosterOp(op: ShareMemberRosterOp): void {
  if (op.op === 'grant_member' && op.member.status === 'revoked') {
    throw new Error('share member roster grant_member cannot grant revoked status');
  }
}
