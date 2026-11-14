/**
 * Which of the account's own devices may exchange Drive events with this one
 * directly, decided from the device roster this device holds and what the
 * relays answered.
 *
 * One relay that answered the roster query completely is enough. Every signed
 * roster operation from every relay, complete answers or partial ones, is
 * merged with the held roster through the anchored validation, so a
 * revocation from any source removes its device. Admission only governs
 * direct exchange between the account's own devices: new Drive versions are
 * encrypted only for still-authorized devices, so a revoked device admitted
 * until another relay's answer arrives sees nothing new.
 */
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from '../drive/protocol';
import { projectAnchoredDriveRoster, type AnchoredDriveRoster } from './driveRosterRefresh';

export interface DriveRosterRelayAnswer {
  relay: string;
  /** The relay sent everything it holds for the query (EOSE) in time. */
  complete: boolean;
}

/** Each relay once, from the answers to several queries: complete only when it answered each completely. */
export function mergeRelayAnswers(answers: readonly DriveRosterRelayAnswer[]): DriveRosterRelayAnswer[] {
  const complete = new Map<string, boolean>();
  for (const answer of answers) complete.set(answer.relay, (complete.get(answer.relay) ?? true) && answer.complete);
  return [...complete].map(([relay, done]) => ({ relay, complete: done }));
}

/**
 * - `confirmed`: a relay answered completely and the answers hold every
 *   operation this device already knew from the authors asked.
 * - `provisional`: no such answer now, but there was one less than `maxAgeMs` ago.
 * - `unconfirmed`: none for `maxAgeMs`; no device is admitted.
 */
export type DriveRosterAdmissionStatus = 'confirmed' | 'provisional' | 'unconfirmed';

export interface DriveRosterAdmissionInput {
  profileId: NostrIdentityId;
  heldRosterOps: readonly SignedNostrIdentityRosterOp[];
  /** Every roster operation any relay returned, complete answers or not. */
  fetchedRosterOps: readonly SignedNostrIdentityRosterOp[];
  /** The authority keys whose operations were asked for. */
  queriedAuthors: readonly string[];
  relays: readonly DriveRosterRelayAnswer[];
  /** When admission was last confirmed, or null. */
  confirmedAt: number | null;
  now: number;
  maxAgeMs: number;
}

export interface DriveRosterAdmission extends AnchoredDriveRoster {
  status: DriveRosterAdmissionStatus;
  confirmedAt: number | null;
  /** Relays without a complete answer, to be asked again. */
  unanswered: string[];
}

export function decideRosterAdmission(input: DriveRosterAdmissionInput): DriveRosterAdmission {
  // Rejects anything that does not descend from the held, trusted chain.
  const anchored = projectAnchoredDriveRoster(input.profileId, input.heldRosterOps, input.fetchedRosterOps);
  const unanswered = input.relays.filter((answer) => !answer.complete).map((answer) => answer.relay);
  const answered = input.relays.length > unanswered.length;
  const confirmed = answered
    && coversKnownHistory(input.queriedAuthors, input.heldRosterOps, input.fetchedRosterOps)
    && !missesAuthorizedParents(input.profileId, input.queriedAuthors, input.heldRosterOps, input.fetchedRosterOps);
  let status: DriveRosterAdmissionStatus;
  let confirmedAt = input.confirmedAt;
  if (confirmed) {
    status = 'confirmed';
    confirmedAt = input.now;
  } else if (confirmedAt !== null && input.now - confirmedAt < input.maxAgeMs) {
    status = 'provisional';
  } else {
    status = 'unconfirmed';
  }
  return { ...anchored, status, confirmedAt, unanswered };
}

/** An answer without an operation this device already holds from those authors is cut short. */
function coversKnownHistory(
  queriedAuthors: readonly string[],
  knownOps: readonly SignedNostrIdentityRosterOp[],
  fetchedOps: readonly SignedNostrIdentityRosterOp[],
): boolean {
  const authors = new Set(queriedAuthors);
  const fetchedIds = new Set(fetchedOps.map((op) => op.op_id));
  return knownOps.every((op) => !authors.has(op.signer_pubkey) || fetchedIds.has(op.op_id));
}

/** An answered operation whose parent nobody sent leaves the authorization chain incomplete. */
function missesAuthorizedParents(
  profileId: NostrIdentityId,
  queriedAuthors: readonly string[],
  heldOps: readonly SignedNostrIdentityRosterOp[],
  fetchedOps: readonly SignedNostrIdentityRosterOp[],
): boolean {
  const knownIds = new Set([...heldOps, ...fetchedOps].map((op) => op.op_id));
  const authors = new Set(queriedAuthors);
  return fetchedOps.some((op) => op.content.profile_id === profileId
    && authors.has(op.signer_pubkey)
    && (op.content.parents ?? []).some((parentId) => !knownIds.has(parentId)));
}
