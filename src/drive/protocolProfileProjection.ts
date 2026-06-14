import type {
  IrisProfileRosterProjection,
  IrisProfileTombstone,
  SignedIrisProfileRosterOp,
} from './protocolTypes';
import { signedIrisProfileRosterOpIsValid } from './protocolProfileValidation';

export function irisProfileRosterParentIds(ops: SignedIrisProfileRosterOp[]): string[] {
  const profileId = ops[0]?.content.profile_id;
  return profileId ? projectIrisProfileRoster(profileId, ops).accepted_op_ids : [];
}

export function projectIrisProfileRoster(
  profileId: IrisProfileId,
  ops: SignedIrisProfileRosterOp[],
): IrisProfileRosterProjection {
  const projection: IrisProfileRosterProjection = {
    profile_id: profileId,
    active_facets: {},
    tombstones: {},
    key_epochs: {},
    accepted_op_ids: [],
    rejected_op_ids: [],
  };
  const sorted = ops
    .filter((op) => op.content.profile_id === profileId)
    .slice()
    .sort((a, b) => (a.content.created_at - b.content.created_at) || a.op_id.localeCompare(b.op_id));
  for (const signed of sorted) {
    if (!signedIrisProfileRosterOpIsValid(signed)) {
      projection.rejected_op_ids.push(signed.op_id);
      continue;
    }
    if (!applyRosterOp(projection, signed)) {
      projection.rejected_op_ids.push(signed.op_id);
      continue;
    }
    projection.accepted_op_ids.push(signed.op_id);
  }
  return projection;
}

export function applyRosterOp(
  projection: IrisProfileRosterProjection,
  signed: SignedIrisProfileRosterOp,
): boolean {
  const op = signed.content.op;
  if (op.op === 'add_facet') {
    if (projection.tombstones[op.facet.pubkey]) return false;
    projection.active_facets[op.facet.pubkey] ??= {
      ...op.facet,
      purposes: op.facet.purposes ?? [],
      capabilities: op.facet.capabilities ?? {},
    };
    return true;
  }
  if (op.op === 'tombstone_facet') {
    const profileId = projection.active_facets[op.pubkey]?.profile_id;
    delete projection.active_facets[op.pubkey];
    const tombstone: IrisProfileTombstone = {
      pubkey: op.pubkey,
      removed_by_pubkey: signed.signer_pubkey,
      removed_at: signed.content.created_at,
      reason: op.reason,
    };
    if (profileId) tombstone.profile_id = profileId;
    projection.tombstones[op.pubkey] = tombstone;
    return true;
  }
  if (op.op === 'set_capabilities') {
    const facet = projection.active_facets[op.pubkey];
    if (!facet || projection.tombstones[op.pubkey]) return false;
    facet.capabilities = op.capabilities;
    return true;
  }
  if (op.op === 'rotate_key_epoch') {
    projection.key_epochs[String(op.epoch)] = {
      epoch: op.epoch,
      created_at: signed.content.created_at,
      signed_by_pubkey: signed.signer_pubkey,
      wrapped_dck: op.wrapped_dck ?? {},
    };
    return true;
  }
  if (op.op === 'repair_key_wraps') {
    const epoch = projection.key_epochs[String(op.epoch)];
    if (!epoch || epoch.signed_by_pubkey !== signed.signer_pubkey) return false;
    epoch.wrapped_dck = { ...epoch.wrapped_dck, ...(op.wrapped_dck ?? {}) };
    return true;
  }
  return false;
}
