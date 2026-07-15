import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools';
import { toHex } from '@hashtree/core';
import {
  D_TAG_APP_KEYS,
  NOSTR_IDENTITY_ROSTER_SCHEMA,
  KIND_APP_KEYS,
  KIND_DRIVE_ROOT,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  KIND_LEGACY_DRIVE_ROOT,
  KIND_SHARE_ROSTER_CHECKPOINT,
  SHARE_INVITE_PREFIX,
  buildAppKeysEvent,
  buildDriveRootEvent,
  buildNostrIdentityRosterOpEvent,
  driveRootDTag,
  encodeShareInvite,
  nostrIdentityRosterOpDTag,
  nostrIdentityRosterParentIds,
  isDriveRootEventNewer,
  parseAppKeysEvent,
  parseDriveRootEventForDevice,
  parseDriveRootEventPreview,
  parseNostrIdentityRosterOpEvent,
  parseShareInvite,
  projectNostrIdentityRoster,
  projectSharedFolderMemberRoster,
  projectSharedFolderView,
  resolveShareRecipientFromEvidence,
  resolveShareRecipientFromProfileEvidence,
  sharedFolderAppKeyWriteAuthorization,
  sharedFolderAuthorizedWriterPubkeys,
  sharedFolderKeyRecipientPubkeys,
  sharedFolderFromInviteForProfile,
  shareRecipientsForResolvedRecipient,
  signNostrIdentityFacetAcceptance,
  signNostrIdentityRosterOp,
  signShareRosterCheckpoint,
  wrapDriveContentKeyForAppKeys,
  type SharedFolder,
  type ShareInviteBundle,
} from '../src/drive/protocol';
import {
  appFacet,
  encryptedRoot,
  facetAcceptance,
  signedRosterOp,
  signedShareKeyRosterOps,
  signedShareMemberOp,
  socialFacet,
} from './driveProtocolInterop.helpers';


describe('iris-drive protocol invites and recipients', () => {
  it('parses share invite bundles and rejects invites for another profile', () => {
    const shareId = '123e4567-e89b-42d3-a456-426614174002';
    const recipientProfile = '123e4567-e89b-42d3-a456-426614174020';
    const otherProfile = '123e4567-e89b-42d3-a456-426614174021';
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: otherProfile,
      source_path: 'Photos',
      display_name: 'Photos',
      local_role: 'reader',
      members: {
        [otherProfile]: {
          profile_id: otherProfile,
          role: 'admin',
          status: 'active',
          display_name: 'Owner',
        },
        [recipientProfile]: {
          profile_id: recipientProfile,
          role: 'reader',
          status: 'active',
          display_name: 'Recipient',
        },
      },
      participant_profiles: {},
      roster_ops: [],
    };
    const bundle: ShareInviteBundle = {
      schema: 1,
      shared_folder: folder,
      recipient_profile_id: recipientProfile,
      role: 'reader',
      created_at: 1_700_002_000,
    };
    const invite = `${SHARE_INVITE_PREFIX}${Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64url')}`;

    expect(parseShareInvite(invite).shared_folder.share_id).toBe(shareId);
    expect(sharedFolderFromInviteForProfile(invite, recipientProfile).display_name).toBe('Photos');
    expect(() => sharedFolderFromInviteForProfile(invite, otherProfile)).toThrow(/not for NostrIdentity/);
  });

  it('validates signed share roster checkpoints in invite bundles', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174031';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174032';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174033';
    const { ownerOp, aliceOp, epochOp } = signedShareKeyRosterOps(
      ownerSecret,
      shareId,
      ownerPubkey,
      ownerProfile,
      alicePubkey,
      aliceProfile,
    );
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: ownerProfile,
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
      local_role: 'admin',
      members: {
        [ownerProfile]: {
          profile_id: ownerProfile,
          role: 'admin',
          status: 'active',
          display_name: 'Owner',
        },
        [aliceProfile]: {
          profile_id: aliceProfile,
          role: 'reader',
          status: 'active',
          representative_npub_hint: 'npub1alice',
          display_name: 'Alice',
        },
      },
      participant_profiles: {
        [ownerPubkey]: ownerProfile,
        [alicePubkey]: aliceProfile,
      },
      roster_ops: [ownerOp, aliceOp, epochOp],
    };
    const nonce = '123e4567-e89b-42d3-a456-426614174034';
    const checkpoint = signShareRosterCheckpoint({
      signerSecretKey: ownerSecret,
      folder,
      clientNonce: nonce,
      createdAt: 13,
    });
    const checkpointEvent = JSON.parse(checkpoint.event_json);
    expect(checkpointEvent.kind).toBe(KIND_SHARE_ROSTER_CHECKPOINT);
    expect(checkpointEvent.tags).toContainEqual(['d', `iris-drive/share/${shareId}/roster-checkpoint/${nonce}`]);
    expect(checkpointEvent.tags).toContainEqual(['i', shareId]);
    expect(checkpointEvent.tags).toContainEqual(['p', ownerPubkey]);
    expect(checkpoint.content).toMatchObject({
      share_id: shareId,
      signer_pubkey: ownerPubkey,
      roster_head_op_ids: [epochOp.op_id],
      accepted_op_count: 3,
      rejected_op_count: 0,
      active_app_key_pubkeys: [alicePubkey, ownerPubkey].sort(),
      tombstoned_app_key_pubkeys: [],
      current_key_epoch: 1,
      client_nonce: nonce,
      created_at: 13,
    });
    expect(checkpoint.content.members.map((member) => member.profile_id)).toEqual([aliceProfile, ownerProfile]);
    const bundle: ShareInviteBundle = {
      schema: 1,
      shared_folder: folder,
      recipient_profile_id: aliceProfile,
      role: 'reader',
      representative_npub_hint: 'npub1alice',
      roster_checkpoint: checkpoint,
      created_at: 13,
    };
    const invite = encodeShareInvite(bundle);

    expect(parseShareInvite(invite).roster_checkpoint?.content.roster_head_op_ids).toEqual([epochOp.op_id]);

    const tampered = structuredClone(bundle);
    tampered.roster_checkpoint!.content.accepted_op_count = 4;
    const tamperedInvite = encodeShareInvite(tampered);
    expect(() => parseShareInvite(tamperedInvite)).toThrow(/checkpoint/);
  });

  it('resolves representative social proof to one NostrIdentity recipient entity', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const socialSecret = generateSecretKey();
    const phoneSecret = generateSecretKey();
    const laptopSecret = generateSecretKey();
    const socialPubkey = getPublicKey(socialSecret);
    const phonePubkey = getPublicKey(phoneSecret);
    const laptopPubkey = getPublicKey(laptopSecret);
    const profileId = '123e4567-e89b-42d3-a456-426614174041';
    const adminOp = signedRosterOp(adminSecret, profileId, 10, {
      op: 'add_facet',
      facet: appFacet(adminPubkey, 10, 'Admin', true, true),
    });
    const socialOp = signedRosterOp(adminSecret, profileId, 11, {
      op: 'add_facet',
      facet: socialFacet(socialPubkey, 11, 'Alice'),
    }, [adminOp.op_id]);
    const phoneOp = signedRosterOp(adminSecret, profileId, 12, {
      op: 'add_facet',
      facet: appFacet(phonePubkey, 12, 'Phone', false, false),
    }, [socialOp.op_id]);
    const laptopOp = signedRosterOp(adminSecret, profileId, 13, {
      op: 'add_facet',
      facet: appFacet(laptopPubkey, 13, 'Laptop', false, false),
    }, [phoneOp.op_id]);
    const laptopTombstoneOp = signedRosterOp(adminSecret, profileId, 14, {
      op: 'tombstone_facet',
      pubkey: laptopPubkey,
      reason: 'old install',
    }, [laptopOp.op_id]);
    const ops = [adminOp, socialOp, phoneOp, laptopOp, laptopTombstoneOp];
    const acceptances = [
      facetAcceptance(socialSecret, profileId, ['social_profile'], 20),
      facetAcceptance(phoneSecret, profileId, ['app_key'], 21),
      facetAcceptance(laptopSecret, profileId, ['app_key'], 22),
    ];

    const resolved = resolveShareRecipientFromProfileEvidence(
      profileId,
      socialPubkey,
      ops,
      acceptances,
    );

    expect(resolved).toMatchObject({
      profile_id: profileId,
      representative_pubkey: socialPubkey,
      representative_npub: nip19.npubEncode(socialPubkey),
      display_name: 'Alice',
      app_pubkeys: [phonePubkey],
      linked_social_pubkeys: [socialPubkey],
    });
    expect(shareRecipientsForResolvedRecipient(resolved, 'reader')).toEqual([{
      profile_id: profileId,
      app_pubkey: phonePubkey,
      role: 'reader',
      representative_npub_hint: nip19.npubEncode(socialPubkey),
      display_name: 'Alice',
    }]);
  });

  it('resolves recipient evidence bundles with facet_acceptances alias', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const socialSecret = generateSecretKey();
    const phoneSecret = generateSecretKey();
    const socialPubkey = getPublicKey(socialSecret);
    const phonePubkey = getPublicKey(phoneSecret);
    const profileId = '123e4567-e89b-42d3-a456-426614174043';
    const adminOp = signedRosterOp(adminSecret, profileId, 10, {
      op: 'add_facet',
      facet: appFacet(adminPubkey, 10, 'Admin', true, true),
    });
    const socialOp = signedRosterOp(adminSecret, profileId, 11, {
      op: 'add_facet',
      facet: socialFacet(socialPubkey, 11, 'Alice'),
    }, [adminOp.op_id]);
    const phoneOp = signedRosterOp(adminSecret, profileId, 12, {
      op: 'add_facet',
      facet: appFacet(phonePubkey, 12, 'Phone', false, false),
    }, [socialOp.op_id]);
    const ops = [adminOp, socialOp, phoneOp];
    const resolved = resolveShareRecipientFromEvidence({
      profile_id: profileId,
      representative_npub: nip19.npubEncode(socialPubkey),
      roster_ops: ops,
      facet_acceptances: [
        facetAcceptance(socialSecret, profileId, ['social_profile'], 20),
        facetAcceptance(phoneSecret, profileId, ['app_key'], 21),
      ],
    }, 'Alice Cooper');

    expect(resolved.display_name).toBe('Alice Cooper');
    expect(resolved.profile_id).toBe(profileId);
    expect(resolved.app_pubkeys).toEqual([phonePubkey]);
  });

  it('rejects representative share resolution without a self-signed profile link', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const socialPubkey = getPublicKey(generateSecretKey());
    const phoneSecret = generateSecretKey();
    const phonePubkey = getPublicKey(phoneSecret);
    const profileId = '123e4567-e89b-42d3-a456-426614174042';
    const adminOp = signedRosterOp(adminSecret, profileId, 10, {
      op: 'add_facet',
      facet: appFacet(adminPubkey, 10, 'Admin', true, true),
    });
    const socialOp = signedRosterOp(adminSecret, profileId, 11, {
      op: 'add_facet',
      facet: socialFacet(socialPubkey, 11, 'Alice'),
    }, [adminOp.op_id]);
    const phoneOp = signedRosterOp(adminSecret, profileId, 12, {
      op: 'add_facet',
      facet: appFacet(phonePubkey, 12, 'Phone', false, false),
    }, [socialOp.op_id]);
    const ops = [adminOp, socialOp, phoneOp];
    const acceptances = [
      facetAcceptance(phoneSecret, profileId, ['app_key'], 20),
    ];

    expect(() => resolveShareRecipientFromProfileEvidence(
      profileId,
      socialPubkey,
      ops,
      acceptances,
    )).toThrow(/self-signed profile link/);
  });
});
