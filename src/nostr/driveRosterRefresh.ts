import {
  applyRosterOp,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  projectNostrIdentityRoster,
  type NostrIdentityId,
  type NostrIdentityRosterProjection,
  type SignedNostrIdentityRosterOp,
} from '../drive/protocol';

export interface DriveRosterAuthorSnapshot {
  rosterOps: SignedNostrIdentityRosterOp[];
  /** True only after the relay query reached its complete snapshot boundary. */
  complete: boolean;
}

export type DriveRosterAuthorFetcher = (
  authors: readonly string[],
) => Promise<DriveRosterAuthorSnapshot>;

export interface AnchoredDriveRoster {
  rosterOps: SignedNostrIdentityRosterOp[];
  projection: NostrIdentityRosterProjection;
}

const DEFAULT_LIVE_ROSTER_CANDIDATE_LIMIT = 512;

/**
 * Retains a bounded set of relay candidates that could not yet be applied.
 * Roster history is published concurrently, so a child can legitimately be
 * delivered before its parent. Replaying the whole pending set on each event
 * makes that ordering harmless without allowing unbounded profile-tagged spam
 * to accumulate in memory.
 */
export class DriveRosterLiveCandidateBuffer {
  private readonly pending = new Map<string, SignedNostrIdentityRosterOp>();

  constructor(private readonly limit = DEFAULT_LIVE_ROSTER_CANDIDATE_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Drive roster live candidate limit must be a positive integer');
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }

  replay(
    profileId: NostrIdentityId,
    trustedRosterOps: readonly SignedNostrIdentityRosterOp[],
    candidate: SignedNostrIdentityRosterOp,
  ): AnchoredDriveRoster {
    if (candidate.content.profile_id === profileId) {
      // Reinsertion makes the eviction order reflect the most recent delivery.
      this.pending.delete(candidate.op_id);
      this.pending.set(candidate.op_id, candidate);
      while (this.pending.size > this.limit) {
        const oldestId = this.pending.keys().next().value as string | undefined;
        if (!oldestId) break;
        this.pending.delete(oldestId);
      }
    }

    const anchored = projectAnchoredDriveRoster(
      profileId,
      trustedRosterOps,
      [...this.pending.values()],
    );
    const acceptedIds = new Set(anchored.projection.accepted_op_ids);
    for (const pendingId of this.pending.keys()) {
      if (acceptedIds.has(pendingId)) this.pending.delete(pendingId);
    }
    return anchored;
  }
}

/**
 * Relay filter for an authorization-sensitive roster read.
 *
 * The profile-only query used previously allowed arbitrary `#i` spam to fill
 * its event limit before legitimate revocations. Authority authors are derived
 * from the already-trusted local chain, and the query deliberately has no
 * event-count limit.
 */
export function rosterAuthorFilter(
  profileId: NostrIdentityId,
  authors: readonly string[],
): {
  kinds: number[];
  '#i': NostrIdentityId[];
  authors: string[];
} {
  return {
    kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
    '#i': [profileId],
    authors: [...new Set(authors)].sort(),
  };
}

/**
 * Replays relay candidates from the bootstrap already trusted by this device.
 * A relay candidate cannot become a second bootstrap merely by using an older
 * timestamp: every unseen operation must descend from accepted parents and be
 * authorized by the anchored projection at the point where it is applied.
 */
export function projectAnchoredDriveRoster(
  profileId: NostrIdentityId,
  trustedRosterOps: readonly SignedNostrIdentityRosterOp[],
  candidateRosterOps: readonly SignedNostrIdentityRosterOp[] = [],
): AnchoredDriveRoster {
  const trustedProjection = projectNostrIdentityRoster(profileId, [...trustedRosterOps]);
  const trustedAcceptedIds = new Set(trustedProjection.accepted_op_ids);
  const trustedAcceptedOps = trustedRosterOps.filter((op) => trustedAcceptedIds.has(op.op_id));
  const bootstrapId = trustedProjection.accepted_op_ids[0];
  const bootstrap = trustedAcceptedOps.find((op) => op.op_id === bootstrapId);
  if (!bootstrap || !isBootstrapForProfile(profileId, bootstrap)) {
    throw new Error('Stored Drive roster has no trusted bootstrap');
  }

  // First replay only the already-trusted chain. Relay candidates must never
  // be allowed to reorder or reinterpret this accepted authorization state.
  const projection = projectNostrIdentityRoster(profileId, [bootstrap]);
  if (projection.accepted_op_ids[0] !== bootstrap.op_id) {
    throw new Error('Stored Drive roster bootstrap is invalid');
  }
  const accepted = new Map<string, SignedNostrIdentityRosterOp>([[bootstrap.op_id, bootstrap]]);
  const trustedPending = trustedAcceptedOps
    .filter((op) => op.op_id !== bootstrap.op_id)
    .sort(compareRosterOps);
  applyCausallyReadyRosterOps(projection, accepted, trustedPending);

  for (const trustedId of trustedAcceptedIds) {
    if (!accepted.has(trustedId)) {
      throw new Error('Stored Drive roster does not form a complete trusted authorization chain');
    }
  }

  const trustedBaselineIds = new Set(accepted.keys());
  const candidateById = new Map<string, SignedNostrIdentityRosterOp>();
  for (const op of candidateRosterOps) {
    if (
      op.content.profile_id === profileId
      && !trustedBaselineIds.has(op.op_id)
    ) {
      candidateById.set(op.op_id, op);
    }
  }
  const candidatePending = [...candidateById.values()]
    .filter((op) => {
      const parents = new Set(op.content.parents ?? []);
      // Each unseen operation must acknowledge the complete authorization
      // baseline that was already trusted before this relay snapshot. A former
      // admin cannot backdate a fork around its own revocation.
      return [...trustedBaselineIds].every((trustedId) => parents.has(trustedId));
    })
    .sort(compareRosterOps);
  applyCausallyReadyRosterOps(projection, accepted, candidatePending);

  return {
    rosterOps: [...accepted.values()].sort(compareRosterOps),
    projection,
  };
}

/**
 * Establishes a new device's first trust anchor from the signed roster op
 * embedded in its encrypted approval receipt. Only the receipt operation's
 * complete recursive parent closure is allowed to choose the bootstrap; other
 * profile-tagged relay events are considered later, anchored descendants.
 */
export function projectDriveRosterFromApprovalReceipt(
  profileId: NostrIdentityId,
  receiptRosterOp: SignedNostrIdentityRosterOp,
  remoteRosterOps: readonly SignedNostrIdentityRosterOp[],
): AnchoredDriveRoster {
  if (receiptRosterOp.content.profile_id !== profileId) {
    throw new Error('Drive approval receipt roster profile mismatch');
  }
  const parentIds = receiptRosterOp.content.parents ?? [];
  if (parentIds.length === 0) {
    throw new Error('Drive approval receipt has no authorization parent chain');
  }

  const opsById = new Map<string, SignedNostrIdentityRosterOp>();
  for (const op of remoteRosterOps) {
    if (op.content.profile_id === profileId) opsById.set(op.op_id, op);
  }
  // The encrypted receipt is the authority for its exact embedded operation.
  opsById.set(receiptRosterOp.op_id, receiptRosterOp);

  const ancestorIds = new Set<string>();
  const visiting = new Set<string>();
  const visitAncestor = (opId: string): void => {
    if (ancestorIds.has(opId)) return;
    if (visiting.has(opId)) {
      throw new Error('Drive approval receipt authorization parent chain is cyclic');
    }
    const op = opsById.get(opId);
    if (!op || op.op_id === receiptRosterOp.op_id) {
      throw new Error('Drive approval receipt authorization parent chain is incomplete');
    }
    visiting.add(opId);
    for (const parentId of op.content.parents ?? []) visitAncestor(parentId);
    visiting.delete(opId);
    ancestorIds.add(opId);
  };
  for (const parentId of parentIds) visitAncestor(parentId);

  const ancestors = [...ancestorIds].map((opId) => opsById.get(opId)!);
  const withReceipt = projectAnchoredDriveRoster(profileId, ancestors, [receiptRosterOp]);
  const acceptedWithReceipt = new Set(withReceipt.projection.accepted_op_ids);
  if (
    !acceptedWithReceipt.has(receiptRosterOp.op_id)
    || [...ancestorIds].some((opId) => !acceptedWithReceipt.has(opId))
  ) {
    throw new Error('Drive approval receipt roster operation is not authorized by its parent chain');
  }

  const anchored = projectAnchoredDriveRoster(
    profileId,
    withReceipt.rosterOps,
    remoteRosterOps,
  );
  if (!anchored.projection.accepted_op_ids.includes(receiptRosterOp.op_id)) {
    throw new Error('Drive approval receipt roster operation was not accepted');
  }
  return anchored;
}

/**
 * Requires both the exact receipt add-facet operation and a subsequently
 * accepted DCK wrap for that device. An old epoch wrap, or one from an
 * unrelated profile fork, cannot make device activation ready.
 */
export function driveApprovalRosterIsReadyForAppKey(
  anchored: AnchoredDriveRoster,
  receiptRosterOpId: string,
  appKeyPubkey: string,
): boolean {
  const acceptedIds = new Set(anchored.projection.accepted_op_ids);
  if (!acceptedIds.has(receiptRosterOpId)) return false;
  const receiptRosterOp = anchored.rosterOps.find((op) => op.op_id === receiptRosterOpId);
  const receiptOp = receiptRosterOp?.content.op;
  if (receiptOp?.op !== 'add_facet' || receiptOp.facet.pubkey !== appKeyPubkey) return false;

  const facet = anchored.projection.active_facets[appKeyPubkey];
  const latestEpoch = Object.values(anchored.projection.secret_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (
    !facet?.capabilities?.can_write_roots
    || !facet.capabilities.can_receive_secret_wraps
    || !facet.capabilities.can_decrypt_secret_epochs
    || !latestEpoch?.wrapped_secrets[appKeyPubkey]
  ) {
    return false;
  }

  return anchored.rosterOps.some((signed) => {
    if (!acceptedIds.has(signed.op_id) || !(signed.content.parents ?? []).includes(receiptRosterOpId)) {
      return false;
    }
    const op = signed.content.op;
    return (op.op === 'rotate_secret_epoch' || op.op === 'repair_secret_wraps')
      && op.epoch === latestEpoch.epoch
      && Boolean(op.wrapped_secrets?.[appKeyPubkey]);
  });
}

function applyCausallyReadyRosterOps(
  projection: NostrIdentityRosterProjection,
  accepted: Map<string, SignedNostrIdentityRosterOp>,
  sourceOps: readonly SignedNostrIdentityRosterOp[],
): void {
  const pending = [...sourceOps];
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (let index = 0; index < pending.length;) {
      const signed = pending[index];
      const parents = signed.content.parents ?? [];
      if (
        parents.length === 0
        || !parents.every((parentId) => accepted.has(parentId))
        || parents.some((parentId) => (
          accepted.get(parentId)!.content.created_at > signed.content.created_at
        ))
      ) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      if (!applyRosterOp(projection, signed)) continue;
      projection.accepted_op_ids.push(signed.op_id);
      accepted.set(signed.op_id, signed);
      madeProgress = true;
    }
  }
}

/**
 * Fetches complete per-author relay snapshots, expanding the query only when
 * the anchored chain grants admin/recovery authority to another key.
 */
export async function fetchAuthoritativeDriveRoster(options: {
  profileId: NostrIdentityId;
  trustedRosterOps: readonly SignedNostrIdentityRosterOp[];
  fetchAuthors: DriveRosterAuthorFetcher;
}): Promise<AnchoredDriveRoster> {
  const fetchedById = new Map<string, SignedNostrIdentityRosterOp>();
  const queriedAuthors = new Set<string>();
  let anchored = projectAnchoredDriveRoster(options.profileId, options.trustedRosterOps);

  while (true) {
    const nextAuthors = rosterAuthorityAuthors(anchored.projection)
      .filter((author) => !queriedAuthors.has(author));
    if (nextAuthors.length === 0) return anchored;

    const snapshot = await options.fetchAuthors(nextAuthors);
    if (!snapshot.complete) {
      throw new Error('Could not establish a complete Drive roster snapshot from relays');
    }
    assertSnapshotCoversKnownAuthorHistory(nextAuthors, anchored.rosterOps, snapshot.rosterOps);
    for (const author of nextAuthors) queriedAuthors.add(author);
    const queriedThisRound = new Set(nextAuthors);
    for (const op of snapshot.rosterOps) {
      // Do not trust relays to enforce the author filter themselves.
      if (
        op.content.profile_id === options.profileId
        && queriedThisRound.has(op.signer_pubkey)
      ) {
        fetchedById.set(op.op_id, op);
      }
    }

    anchored = projectAnchoredDriveRoster(
      options.profileId,
      options.trustedRosterOps,
      [...fetchedById.values()],
    );
    assertNoMissingAuthorizedParents(
      options.profileId,
      nextAuthors,
      snapshot.rosterOps,
      options.trustedRosterOps,
      [...fetchedById.values()],
    );
  }
}

function assertSnapshotCoversKnownAuthorHistory(
  queriedAuthors: readonly string[],
  knownOps: readonly SignedNostrIdentityRosterOp[],
  snapshotOps: readonly SignedNostrIdentityRosterOp[],
): void {
  const authors = new Set(queriedAuthors);
  const snapshotIds = new Set(snapshotOps.map((op) => op.op_id));
  if (knownOps.some((op) => authors.has(op.signer_pubkey) && !snapshotIds.has(op.op_id))) {
    throw new Error('Could not establish a complete Drive roster snapshot from relays');
  }
}

function rosterAuthorityAuthors(projection: NostrIdentityRosterProjection): string[] {
  return Object.values(projection.active_facets)
    .filter((facet) => (
      facet.capabilities?.can_admin_profile
      || facet.capabilities?.can_recover_app_keys
    ))
    .map((facet) => facet.pubkey)
    .sort();
}

function assertNoMissingAuthorizedParents(
  profileId: NostrIdentityId,
  queriedAuthors: readonly string[],
  snapshotOps: readonly SignedNostrIdentityRosterOp[],
  trustedOps: readonly SignedNostrIdentityRosterOp[],
  fetchedOps: readonly SignedNostrIdentityRosterOp[],
): void {
  const knownIds = new Set([...trustedOps, ...fetchedOps].map((op) => op.op_id));
  const authors = new Set(queriedAuthors);
  for (const op of snapshotOps) {
    if (op.content.profile_id !== profileId || !authors.has(op.signer_pubkey)) continue;
    const parents = op.content.parents ?? [];
    if (parents.length > 0 && parents.some((parentId) => !knownIds.has(parentId))) {
      throw new Error('Could not establish a complete Drive roster authorization chain');
    }
  }
}

function isBootstrapForProfile(
  profileId: NostrIdentityId,
  signed: SignedNostrIdentityRosterOp,
): boolean {
  const op = signed.content.op;
  return signed.content.profile_id === profileId
    && (signed.content.parents?.length ?? 0) === 0
    && signed.signer_pubkey === signed.content.actor_pubkey
    && op.op === 'add_facet'
    && op.facet.pubkey === signed.signer_pubkey
    && Boolean(op.facet.capabilities?.can_admin_profile);
}

function compareRosterOps(
  left: SignedNostrIdentityRosterOp,
  right: SignedNostrIdentityRosterOp,
): number {
  return left.content.created_at - right.content.created_at || left.op_id.localeCompare(right.op_id);
}
