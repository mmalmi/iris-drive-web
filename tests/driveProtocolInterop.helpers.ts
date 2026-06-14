import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { fromHex, type CID } from '@hashtree/core';
import {
  IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA,
  KIND_IRIS_PROFILE_FACET_ACCEPTANCE,
  KIND_SHARE_MEMBER_ROSTER_OP,
  irisProfileFacetAcceptanceDTag,
  parseIrisProfileFacetAcceptanceEvent,
  shareMemberRosterOpDTag,
  signIrisProfileRosterOp,
  type IrisProfileKeyPurpose,
  type IrisProfileRosterOp,
  type ShareMemberRosterOp,
  type SignedIrisProfileFacetAcceptance,
  type SignedShareMemberRosterOp,
} from '../src/drive/protocol';

export function encryptedRoot(hashSeed: string, keySeed: string): CID {
  return {
    hash: fromHex(hashSeed.repeat(32)),
    key: fromHex(keySeed.repeat(32)),
  };
}

export function signedRosterOp(
  signerSecretKey: Uint8Array,
  profileId: string,
  createdAt: number,
  op: IrisProfileRosterOp,
  parents: string[] = [],
) {
  return signIrisProfileRosterOp({
    signerSecretKey,
    profileId,
    parents,
    createdAt,
    op,
  });
}

export function signedShareKeyRosterOps(
  ownerSecret: Uint8Array,
  shareId: string,
  ownerPubkey: string,
  ownerProfile: string,
  recipientPubkey: string,
  recipientProfile: string,
) {
  const ownerOp = signIrisProfileRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    createdAt: 10,
    op: {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    },
  });
  const aliceOp = signIrisProfileRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    parents: [ownerOp.op_id],
    createdAt: 11,
    op: {
      op: 'add_facet',
      facet: appFacet(recipientPubkey, 11, 'Alice phone', false, false, recipientProfile),
    },
  });
  const epochOp = signIrisProfileRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    parents: [ownerOp.op_id, aliceOp.op_id],
    createdAt: 12,
    op: {
      op: 'rotate_key_epoch',
      epoch: 1,
      wrapped_dck: { [ownerPubkey]: 'owner-wrap', [recipientPubkey]: 'alice-wrap' },
    },
  });
  return { ownerOp, aliceOp, epochOp };
}

export function signedShareMemberOp(
  signerSecretKey: Uint8Array,
  shareId: string,
  createdAt: number,
  op: ShareMemberRosterOp,
  parents: string[] = [],
  keyRosterParents: string[] = [],
  clientNonce = `${createdAt}-member-op`,
): SignedShareMemberRosterOp {
  const signerPubkey = getPublicKey(signerSecretKey);
  const content = {
    schema: 1,
    share_id: shareId,
    actor_pubkey: signerPubkey,
    parents,
    key_roster_parents: keyRosterParents,
    client_nonce: clientNonce,
    created_at: createdAt,
    op,
  };
  const event = finalizeEvent({
    kind: KIND_SHARE_MEMBER_ROSTER_OP,
    content: JSON.stringify(content),
    created_at: createdAt,
    tags: [
      ['d', shareMemberRosterOpDTag(shareId, clientNonce)],
      ['i', shareId],
      ['p', signerPubkey],
    ],
  }, signerSecretKey);
  return {
    op_id: event.id,
    signer_pubkey: event.pubkey,
    content,
    event_json: JSON.stringify(event),
  };
}

export function appFacet(
  pubkey: string,
  addedAt: number,
  label: string,
  canWrite: boolean,
  canAdmin: boolean,
  profileId?: string,
) {
  return {
    pubkey,
    ...(profileId ? { profile_id: profileId } : {}),
    purposes: ['app_key' as const],
    capabilities: {
      can_write_roots: canWrite,
      can_admin_profile: canAdmin,
      can_receive_key_wraps: true,
      can_decrypt_key_epochs: true,
    },
    added_at: addedAt,
    label,
  };
}

export function socialFacet(pubkey: string, addedAt: number, label: string, profileId?: string) {
  return {
    pubkey,
    ...(profileId ? { profile_id: profileId } : {}),
    purposes: ['social_profile' as const],
    capabilities: {},
    added_at: addedAt,
    label,
  };
}

export function facetAcceptance(
  secretKey: Uint8Array,
  profileId: string,
  purposes: IrisProfileKeyPurpose[],
  acceptedAt: number,
): SignedIrisProfileFacetAcceptance {
  const facetPubkey = getPublicKey(secretKey);
  const nonce = `${facetPubkey.slice(0, 12)}-${acceptedAt}`;
  const event = finalizeEvent({
    kind: KIND_IRIS_PROFILE_FACET_ACCEPTANCE,
    content: JSON.stringify({
      schema: IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA,
      profile_id: profileId,
      facet_pubkey: facetPubkey,
      purposes,
      client_nonce: nonce,
      accepted_at: acceptedAt,
    }),
    created_at: acceptedAt,
    tags: [
      ['d', irisProfileFacetAcceptanceDTag(profileId, nonce)],
      ['i', profileId],
      ['p', facetPubkey],
    ],
  }, secretKey);
  return parseIrisProfileFacetAcceptanceEvent(event);
}
