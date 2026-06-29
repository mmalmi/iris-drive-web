import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { fromHex, type CID } from '@hashtree/core';
import {
  KIND_SHARE_MEMBER_ROSTER_OP,
  shareMemberRosterOpDTag,
  signNostrIdentityFacetAcceptance,
  signNostrIdentityRosterOp,
  type NostrIdentityKeyPurpose,
  type NostrIdentityRosterOp,
  type ShareMemberRosterOp,
  type SignedNostrIdentityFacetAcceptance,
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
  op: NostrIdentityRosterOp,
  parents: string[] = [],
) {
  return signNostrIdentityRosterOp({
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
  const ownerOp = signNostrIdentityRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    createdAt: 10,
    op: {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    },
  });
  const aliceOp = signNostrIdentityRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    parents: [ownerOp.op_id],
    createdAt: 11,
    op: {
      op: 'add_facet',
      facet: appFacet(recipientPubkey, 11, 'Alice phone', false, false, recipientProfile),
    },
  });
  const epochOp = signNostrIdentityRosterOp({
    signerSecretKey: ownerSecret,
    profileId: shareId,
    parents: [ownerOp.op_id, aliceOp.op_id],
    createdAt: 12,
    op: {
      op: 'rotate_secret_epoch',
      epoch: 1,
      wrapped_secrets: { [ownerPubkey]: 'owner-wrap', [recipientPubkey]: 'alice-wrap' },
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
  _label: string,
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
      can_receive_secret_wraps: true,
      can_decrypt_secret_epochs: true,
    },
    added_at: addedAt,
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
  purposes: NostrIdentityKeyPurpose[],
  acceptedAt: number,
): SignedNostrIdentityFacetAcceptance {
  const facetPubkey = getPublicKey(secretKey);
  const nonce = `${facetPubkey.slice(0, 12)}-${acceptedAt}`;
  return signNostrIdentityFacetAcceptance({
    signerSecretKey: secretKey,
    profileId,
    purposes,
    clientNonce: nonce,
    acceptedAt,
  });
}
