import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import {
  IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA,
  IRIS_PROFILE_ROSTER_SCHEMA,
  KIND_IRIS_PROFILE_FACET_ACCEPTANCE,
  KIND_IRIS_PROFILE_ROSTER_OP,
  type BuildIrisProfileFacetAcceptanceEventOptions,
  type BuildIrisProfileRosterOpEventOptions,
  type IrisProfileFacetAcceptanceContent,
  type IrisProfileRosterOpContent,
  type SignedIrisProfileFacetAcceptance,
  type SignedIrisProfileRosterOp,
} from './protocolTypes';
import {
  currentUnixSeconds,
  isHex32,
  parseObject,
  randomClientNonce,
  requireIdentifier,
  requireKind,
  requireValidSignature,
} from './protocolJson';
import {
  irisProfileFacetAcceptanceDTag,
  irisProfileRosterOpDTag,
  parseIrisProfileFacetAcceptanceDTag,
  parseIrisProfileRosterOpDTag,
} from './protocolDtags';
import { normalizeRosterOp, rosterOpMentionedPubkeys, sortPurposes } from './protocolProfileNormalize';

export function buildIrisProfileRosterOpEvent(options: BuildIrisProfileRosterOpEventOptions): Event {
  const signerPubkey = getPublicKey(options.signerSecretKey);
  const createdAt = options.createdAt ?? currentUnixSeconds();
  const clientNonce = options.clientNonce ?? randomClientNonce();
  const parents = options.parents?.slice() ?? [];
  const content: IrisProfileRosterOpContent = {
    schema: IRIS_PROFILE_ROSTER_SCHEMA,
    profile_id: options.profileId,
    actor_pubkey: signerPubkey,
    ...(options.actorSeq !== undefined ? { actor_seq: options.actorSeq } : {}),
    ...(parents.length ? { parents } : {}),
    client_nonce: clientNonce,
    created_at: createdAt,
    op: normalizeRosterOp(options.op),
  };

  return finalizeEvent({
    kind: KIND_IRIS_PROFILE_ROSTER_OP,
    content: JSON.stringify(content),
    created_at: createdAt,
    tags: [
      ['d', irisProfileRosterOpDTag(options.profileId, clientNonce)],
      ['i', options.profileId],
      ...rosterOpMentionedPubkeys(content.op).map((pubkey) => ['p', pubkey]),
    ],
  }, options.signerSecretKey);
}

export function signIrisProfileRosterOp(
  options: BuildIrisProfileRosterOpEventOptions,
): SignedIrisProfileRosterOp {
  return parseIrisProfileRosterOpEvent(buildIrisProfileRosterOpEvent(options));
}

export function buildIrisProfileFacetAcceptanceEvent(
  options: BuildIrisProfileFacetAcceptanceEventOptions,
): Event {
  const facetPubkey = getPublicKey(options.signerSecretKey);
  const acceptedAt = options.acceptedAt ?? currentUnixSeconds();
  const clientNonce = options.clientNonce ?? randomClientNonce();
  const purposes = sortPurposes(options.purposes);
  const content: IrisProfileFacetAcceptanceContent = {
    schema: IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA,
    profile_id: options.profileId,
    facet_pubkey: facetPubkey,
    purposes,
    ...(options.rosterOpId !== undefined ? { roster_op_id: options.rosterOpId } : {}),
    client_nonce: clientNonce,
    accepted_at: acceptedAt,
  };

  return finalizeEvent({
    kind: KIND_IRIS_PROFILE_FACET_ACCEPTANCE,
    content: JSON.stringify(content),
    created_at: acceptedAt,
    tags: [
      ['d', irisProfileFacetAcceptanceDTag(options.profileId, clientNonce)],
      ['i', options.profileId],
      ['p', facetPubkey],
      ...(options.rosterOpId !== undefined ? [['e', options.rosterOpId]] : []),
    ],
  }, options.signerSecretKey);
}

export function signIrisProfileFacetAcceptance(
  options: BuildIrisProfileFacetAcceptanceEventOptions,
): SignedIrisProfileFacetAcceptance {
  return parseIrisProfileFacetAcceptanceEvent(buildIrisProfileFacetAcceptanceEvent(options));
}

export function parseIrisProfileRosterOpEvent(event: Event): SignedIrisProfileRosterOp {
  requireKind(event, KIND_IRIS_PROFILE_ROSTER_OP);
  const dTag = requireIdentifier(event);
  const { profileId, nonce } = parseIrisProfileRosterOpDTag(dTag);
  requireValidSignature(event);
  const content = parseObject(event.content) as unknown as IrisProfileRosterOpContent;
  if (content.schema !== IRIS_PROFILE_ROSTER_SCHEMA) {
    throw new Error(`unsupported IrisProfile roster schema ${content.schema}`);
  }
  if (content.profile_id !== profileId) {
    throw new Error(`roster profile mismatch: ${content.profile_id} != ${profileId}`);
  }
  if (content.client_nonce !== nonce) {
    throw new Error('roster nonce mismatch');
  }
  if (content.actor_pubkey !== event.pubkey) {
    throw new Error('roster actor signer mismatch');
  }
  return {
    op_id: event.id,
    signer_pubkey: event.pubkey,
    content: {
      ...content,
      parents: content.parents ?? [],
    },
    event_json: JSON.stringify(event),
  };
}

export function parseIrisProfileFacetAcceptanceEvent(event: Event): SignedIrisProfileFacetAcceptance {
  requireKind(event, KIND_IRIS_PROFILE_FACET_ACCEPTANCE);
  const dTag = requireIdentifier(event);
  const { profileId, nonce } = parseIrisProfileFacetAcceptanceDTag(dTag);
  requireValidSignature(event);
  const content = parseObject(event.content) as unknown as IrisProfileFacetAcceptanceContent;
  if (content.schema !== IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA) {
    throw new Error(`unsupported IrisProfile facet acceptance schema ${content.schema}`);
  }
  if (content.profile_id !== profileId) {
    throw new Error(`facet acceptance profile mismatch: ${content.profile_id} != ${profileId}`);
  }
  if (content.client_nonce !== nonce) {
    throw new Error('facet acceptance nonce mismatch');
  }
  if (content.accepted_at !== event.created_at) {
    throw new Error('facet acceptance accepted_at mismatch');
  }
  if (content.facet_pubkey !== event.pubkey) {
    throw new Error('facet acceptance signer mismatch');
  }
  if (!isHex32(content.facet_pubkey)) {
    throw new Error('facet acceptance pubkey is invalid');
  }
  if (!Array.isArray(content.purposes) || content.purposes.length === 0) {
    throw new Error('facet acceptance purposes must not be empty');
  }
  if (content.roster_op_id && !isHex32(content.roster_op_id)) {
    throw new Error('facet acceptance roster op id is invalid');
  }
  return {
    acceptance_id: event.id,
    signer_pubkey: event.pubkey,
    content,
    event_json: JSON.stringify(event),
  };
}
