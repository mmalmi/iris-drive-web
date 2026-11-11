import {
  projectNostrIdentityRoster as projectRoster,
  type NostrIdentityId,
  type NostrIdentityRosterProjection,
  type SignedNostrIdentityRosterOp,
} from 'nostr-social-graph';

export { applyRosterOp, nostrIdentityRosterParentIds } from 'nostr-social-graph';

const MAX_CACHED_PROJECTIONS = 16;
const projections = new Map<string, NostrIdentityRosterProjection>();

/**
 * Projecting a roster parses and signature-checks every op, and the same
 * roster is projected many times a second while a Drive is open. The key
 * covers every field the projection reads, so an op that differs in any way
 * is checked again. Callers extend the result, so each gets its own copy.
 */
export function projectNostrIdentityRoster(
  profileId: NostrIdentityId,
  ops: SignedNostrIdentityRosterOp[],
): NostrIdentityRosterProjection {
  const key = JSON.stringify([profileId, ops]);
  let projection = projections.get(key);
  if (projection) {
    projections.delete(key);
  } else {
    projection = projectRoster(profileId, ops);
    if (projections.size >= MAX_CACHED_PROJECTIONS) {
      projections.delete(projections.keys().next().value!);
    }
  }
  projections.set(key, projection);
  return structuredClone(projection);
}
