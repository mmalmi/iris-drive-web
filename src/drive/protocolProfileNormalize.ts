import type {
  IrisProfileCapabilities,
  IrisProfileFacet,
  IrisProfileKeyPurpose,
  IrisProfileRosterOp,
  IrisProfileRosterOpContent,
} from './protocolTypes';
import { sortRecord } from './protocolJson';

export function normalizeIrisProfileRosterOpContent(
  content: IrisProfileRosterOpContent,
): IrisProfileRosterOpContent {
  return {
    schema: content.schema,
    profile_id: content.profile_id,
    actor_pubkey: content.actor_pubkey,
    ...(content.actor_seq !== undefined ? { actor_seq: content.actor_seq } : {}),
    ...(content.parents?.length ? { parents: content.parents.slice() } : {}),
    client_nonce: content.client_nonce,
    created_at: content.created_at,
    op: normalizeRosterOp(content.op),
  };
}

export function normalizeRosterOp(op: IrisProfileRosterOp): IrisProfileRosterOp {
  if (op.op === 'add_facet') {
    return {
      op: 'add_facet',
      facet: normalizeFacet(op.facet),
    };
  }
  if (op.op === 'tombstone_facet') {
    return {
      op: 'tombstone_facet',
      pubkey: op.pubkey,
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
    };
  }
  if (op.op === 'set_capabilities') {
    return {
      op: 'set_capabilities',
      pubkey: op.pubkey,
      capabilities: normalizeCapabilities(op.capabilities),
    };
  }
  if (op.op === 'rotate_key_epoch') {
    const wrapped = sortRecord(op.wrapped_dck ?? {});
    return {
      op: 'rotate_key_epoch',
      epoch: op.epoch,
      ...(Object.keys(wrapped).length ? { wrapped_dck: wrapped } : {}),
    };
  }
  const wrapped = sortRecord(op.wrapped_dck ?? {});
  return {
    op: 'repair_key_wraps',
    epoch: op.epoch,
    ...(Object.keys(wrapped).length ? { wrapped_dck: wrapped } : {}),
  };
}

export function normalizeFacet(facet: IrisProfileFacet): IrisProfileFacet {
  return {
    pubkey: facet.pubkey,
    ...(facet.profile_id !== undefined ? { profile_id: facet.profile_id } : {}),
    ...(facet.purposes?.length ? { purposes: sortPurposes(facet.purposes) } : {}),
    capabilities: normalizeCapabilities(facet.capabilities ?? {}),
    added_at: facet.added_at,
    ...(facet.label !== undefined ? { label: facet.label } : {}),
  };
}

export function normalizeCapabilities(capabilities: IrisProfileCapabilities): IrisProfileCapabilities {
  return {
    ...(capabilities.can_write_roots ? { can_write_roots: true } : {}),
    ...(capabilities.can_admin_profile ? { can_admin_profile: true } : {}),
    ...(capabilities.can_recover_app_keys ? { can_recover_app_keys: true } : {}),
    ...(capabilities.can_receive_key_wraps ? { can_receive_key_wraps: true } : {}),
    ...(capabilities.can_decrypt_key_epochs ? { can_decrypt_key_epochs: true } : {}),
  };
}

export function rosterOpMentionedPubkeys(op: IrisProfileRosterOp): string[] {
  if (op.op === 'add_facet') return [op.facet.pubkey];
  if (op.op === 'tombstone_facet' || op.op === 'set_capabilities') return [op.pubkey];
  return Object.keys(op.wrapped_dck ?? {}).sort();
}

export function sortPurposes(purposes: IrisProfileKeyPurpose[]): IrisProfileKeyPurpose[] {
  const unique = Array.from(new Set(purposes));
  if (unique.length === 0) {
    throw new Error('IrisProfile facet acceptance purposes must not be empty');
  }
  return unique.sort((a, b) => purposeRank(a) - purposeRank(b));
}

export function purposeRank(purpose: IrisProfileKeyPurpose): number {
  switch (purpose) {
    case 'app_key':
      return 0;
    case 'recovery_phrase':
      return 1;
    case 'nip46_signer':
      return 2;
    case 'social_profile':
      return 3;
  }
}
