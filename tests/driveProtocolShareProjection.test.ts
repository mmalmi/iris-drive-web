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


describe('iris-drive protocol shared folders', () => {
  it('projects shared folders as NostrIdentity members with AppKeys as subordinate actors', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174001';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174010';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174011';
    const ownerOp = signedRosterOp(ownerSecret, shareId, 10, {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    });
    const aliceOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'add_facet',
      facet: appFacet(alicePubkey, 11, 'Alice phone', true, false, aliceProfile),
    }, [ownerOp.op_id]);
    const epochOp = signedRosterOp(ownerSecret, shareId, 12, {
      op: 'rotate_secret_epoch',
      epoch: 1,
      wrapped_secrets: { [ownerPubkey]: 'owner-wrap', [alicePubkey]: 'alice-wrap' },
    }, [aliceOp.op_id]);
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
          role: 'editor',
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

    const aliceView = projectSharedFolderView(folder, [{
      share_id: shareId,
      path: 'Projects/Alpha',
      target_path: '',
    }], alicePubkey);

    expect(aliceView.local_role).toBe('editor');
    expect(aliceView.local_role_label).toBe('Editor');
    expect(aliceView.can_write).toBe(true);
    expect(aliceView.write_authorization).toBe('authorized');
    expect(aliceView.write_authorization_label).toBe('Authorized');
    expect(aliceView.key_status_label).toBe('Available');
    expect(aliceView.participant_count).toBe(2);
    expect(aliceView.app_key_count).toBe(2);
    expect(aliceView.shortcut_paths).toEqual(['Projects/Alpha']);
    expect(aliceView.members.find((member) => member.profile_id === aliceProfile)).toMatchObject({
      display_name: 'Alice',
      role: 'editor',
      role_label: 'Editor',
      status_label: 'Active',
      app_key_count: 1,
      can_revoke: false,
      can_change_role: false,
    });

    const ownerView = projectSharedFolderView(folder, [], ownerPubkey);
    expect(ownerView.members.find((member) => member.profile_id === ownerProfile)).toMatchObject({
      can_revoke: false,
      can_change_role: false,
    });
    expect(ownerView.members.find((member) => member.profile_id === aliceProfile)).toMatchObject({
      can_revoke: true,
      can_change_role: true,
    });

    const rosterOwnedFolder: SharedFolder = structuredClone(folder);
    rosterOwnedFolder.participant_profiles = {};
    const rosterOwnedView = projectSharedFolderView(rosterOwnedFolder, [], alicePubkey);
    expect(sharedFolderAppKeyWriteAuthorization(rosterOwnedFolder, alicePubkey)).toBe('authorized');
    expect(rosterOwnedView.local_role).toBe('editor');
    expect(rosterOwnedView.key_status).toBe('available');
    expect(rosterOwnedView.members.find((member) => member.profile_id === aliceProfile)).toMatchObject({
      app_key_count: 1,
    });

    folder.members![aliceProfile]!.status = 'revoked';
    const revokedView = projectSharedFolderView(folder, [], alicePubkey);
    expect(revokedView.key_status).toBe('revoked');
    expect(revokedView.can_write).toBe(false);
    expect(revokedView.write_authorization).toBe('revoked_member');
  });

  it('projects representative-npub pending invites without granting member access', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const representativeNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174010';
    const shareId = '123e4567-e89b-42d3-a456-426614174099';
    const ownerOp = signedRosterOp(ownerSecret, shareId, 10, {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    });
    const epochOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'rotate_secret_epoch',
      epoch: 1,
      wrapped_secrets: { [ownerPubkey]: 'owner-wrap' },
    }, [ownerOp.op_id]);
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
      },
      pending_invites: {
        [representativeNpub]: {
          representative_npub_hint: representativeNpub,
          role: 'reader',
          status: 'pending',
          display_name: 'Alice',
          created_at: 12,
        },
      },
      participant_profiles: {
        [ownerPubkey]: ownerProfile,
      },
      roster_ops: [ownerOp, epochOp],
    };

    const view = projectSharedFolderView(folder, [], ownerPubkey);

    expect(view.members).toHaveLength(1);
    expect(view.participant_count).toBe(1);
    expect(view.app_key_count).toBe(1);
    expect(view.pending_invites).toEqual([{
      representative_npub_hint: representativeNpub,
      display_name: 'Alice',
      role: 'reader',
      role_label: 'Reader',
      status: 'pending',
      status_label: 'Pending',
      created_at: 12,
    }]);
  });

  it('projects missing share wraps as a UI count without requiring AppKey display', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174081';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174082';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174083';
    const ownerOp = signedRosterOp(ownerSecret, shareId, 10, {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    });
    const aliceOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'add_facet',
      facet: appFacet(alicePubkey, 11, 'Alice phone', true, false, aliceProfile),
    }, [ownerOp.op_id]);
    const epochOp = signedRosterOp(ownerSecret, shareId, 12, {
      op: 'rotate_secret_epoch',
      epoch: 1,
      wrapped_secrets: { [ownerPubkey]: 'owner-wrap' },
    }, [aliceOp.op_id]);
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
          role: 'editor',
          status: 'active',
          display_name: 'Alice',
        },
      },
      roster_ops: [ownerOp, aliceOp, epochOp],
    };

    const ownerView = projectSharedFolderView(folder, [], ownerPubkey);
    const aliceView = projectSharedFolderView(folder, [], alicePubkey);

    expect(ownerView.key_status).toBe('repair_needed');
    expect(ownerView.missing_key_wrap_count).toBe(1);
    expect(aliceView.key_status).toBe('key_unavailable');
    expect(aliceView.missing_key_wrap_count).toBe(1);
  });

  it('projects share member authority from signed member ops when the cache is empty', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const replacementSecret = generateSecretKey();
    const replacementPubkey = getPublicKey(replacementSecret);
    const shareId = '123e4567-e89b-42d3-a456-426614174041';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174042';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174043';
    const ownerOp = signedRosterOp(ownerSecret, shareId, 10, {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    });
    const aliceOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'add_facet',
      facet: appFacet(alicePubkey, 11, 'Alice phone', true, false, aliceProfile),
    }, [ownerOp.op_id]);
    const replacementOp = signedRosterOp(ownerSecret, shareId, 12, {
      op: 'add_facet',
      facet: appFacet(replacementPubkey, 12, 'Replacement', true, true, ownerProfile),
    }, [ownerOp.op_id, aliceOp.op_id]);
    const ownerTombstoneOp = signedRosterOp(ownerSecret, shareId, 13, {
      op: 'tombstone_facet',
      pubkey: ownerPubkey,
      reason: 'old install',
    }, [replacementOp.op_id]);
    const epochOp = signedRosterOp(replacementSecret, shareId, 14, {
      op: 'rotate_secret_epoch',
      epoch: 1,
      wrapped_secrets: { [replacementPubkey]: 'owner-wrap', [alicePubkey]: 'alice-wrap' },
    }, [ownerTombstoneOp.op_id]);
    const ownerMemberOp = signedShareMemberOp(ownerSecret, shareId, 10, {
      op: 'grant_member',
      member: {
        profile_id: ownerProfile,
        role: 'admin',
        status: 'active',
        display_name: 'Owner',
      },
    }, [], [ownerOp.op_id]);
    const aliceMemberOp = signedShareMemberOp(ownerSecret, shareId, 11, {
      op: 'grant_member',
      member: {
        profile_id: aliceProfile,
        role: 'editor',
        status: 'active',
        representative_npub_hint: 'npub1alice',
        display_name: 'Alice',
      },
    }, [ownerMemberOp.op_id], [ownerOp.op_id, aliceOp.op_id]);
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: ownerProfile,
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
      local_role: 'admin',
      members: {},
      member_ops: [ownerMemberOp, aliceMemberOp],
      participant_profiles: {},
      roster_ops: [ownerOp, aliceOp, replacementOp, ownerTombstoneOp, epochOp],
    };

    const memberProjection = projectSharedFolderMemberRoster(folder);
    const members = memberProjection.members;
    expect(memberProjection.rejected_op_ids).toEqual([]);
    expect(Object.keys(members).sort()).toEqual([aliceProfile, ownerProfile].sort());
    expect(sharedFolderAppKeyWriteAuthorization(folder, alicePubkey)).toBe('authorized');

    const view = projectSharedFolderView(folder, [], alicePubkey);
    expect(view.local_role).toBe('editor');
    expect(view.participant_count).toBe(2);
    expect(view.members.find((member) => member.profile_id === aliceProfile)).toMatchObject({
      display_name: 'Alice',
      role: 'editor',
      app_key_count: 1,
    });

    const checkpoint = signShareRosterCheckpoint({
      signerSecretKey: replacementSecret,
      folder,
      clientNonce: '123e4567-e89b-42d3-a456-426614174044',
      createdAt: 15,
    });
    expect(checkpoint.content).toMatchObject({
      member_roster_head_op_ids: [aliceMemberOp.op_id],
      accepted_member_op_count: 2,
    });
    expect(checkpoint.content.rejected_member_op_count).toBeUndefined();
  });

  it('rejects share invites with tampered member roster event JSON', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174045';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174046';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174047';
    const { ownerOp, aliceOp, epochOp } = signedShareKeyRosterOps(
      ownerSecret,
      shareId,
      ownerPubkey,
      ownerProfile,
      alicePubkey,
      aliceProfile,
    );
    const ownerMemberOp = signedShareMemberOp(ownerSecret, shareId, 10, {
      op: 'grant_member',
      member: {
        profile_id: ownerProfile,
        role: 'admin',
        status: 'active',
        display_name: 'Owner',
      },
    }, [], [ownerOp.op_id], '123e4567-e89b-42d3-a456-426614174048');
    const aliceMemberOp = signedShareMemberOp(ownerSecret, shareId, 11, {
      op: 'grant_member',
      member: {
        profile_id: aliceProfile,
        role: 'reader',
        status: 'active',
        display_name: 'Alice',
      },
    }, [ownerMemberOp.op_id], [ownerOp.op_id, aliceOp.op_id], '123e4567-e89b-42d3-a456-426614174049');
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: ownerProfile,
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
      local_role: 'admin',
      members: {},
      member_ops: [ownerMemberOp, aliceMemberOp],
      participant_profiles: {},
      roster_ops: [ownerOp, aliceOp, epochOp],
    };
    const checkpoint = signShareRosterCheckpoint({
      signerSecretKey: ownerSecret,
      folder,
      clientNonce: '123e4567-e89b-42d3-a456-426614174050',
      createdAt: 13,
    });
    const bundle: ShareInviteBundle = {
      schema: 1,
      shared_folder: folder,
      recipient_profile_id: aliceProfile,
      role: 'reader',
      roster_checkpoint: checkpoint,
      created_at: 13,
    };

    expect(parseShareInvite(encodeShareInvite(bundle)).shared_folder.share_id).toBe(shareId);

    const tampered = structuredClone(bundle);
    tampered.shared_folder.member_ops![0]!.event_json = '{}';
    expect(() => parseShareInvite(encodeShareInvite(tampered))).toThrow(/member roster/);

    const tamperedKeyRoster = structuredClone(bundle);
    tamperedKeyRoster.shared_folder.roster_ops![0]!.event_json = '{}';
    expect(() => parseShareInvite(encodeShareInvite(tamperedKeyRoster))).toThrow(/NostrIdentity roster/);
  });

  it('explains share root write authorization through member identity and AppKey facets', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const readerPubkey = getPublicKey(generateSecretKey());
    const socialPubkey = getPublicKey(generateSecretKey());
    const unknownPubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174051';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174052';
    const readerProfile = '123e4567-e89b-42d3-a456-426614174053';
    const socialProfile = '123e4567-e89b-42d3-a456-426614174054';
    const ownerOp = signedRosterOp(ownerSecret, shareId, 10, {
      op: 'add_facet',
      facet: appFacet(ownerPubkey, 10, 'Owner', true, true, ownerProfile),
    });
    const readerOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'add_facet',
      facet: appFacet(readerPubkey, 11, 'Reader phone', false, false, readerProfile),
    }, [ownerOp.op_id]);
    const socialOp = signedRosterOp(ownerSecret, shareId, 12, {
      op: 'add_facet',
      facet: socialFacet(socialPubkey, 12, 'Social', socialProfile),
    }, [readerOp.op_id]);
    const unboundReaderOp = signedRosterOp(ownerSecret, shareId, 11, {
      op: 'add_facet',
      facet: appFacet(readerPubkey, 11, 'Reader phone', false, false),
    }, [ownerOp.op_id]);
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
        [readerProfile]: {
          profile_id: readerProfile,
          role: 'reader',
          status: 'active',
          display_name: 'Reader',
        },
        [socialProfile]: {
          profile_id: socialProfile,
          role: 'editor',
          status: 'active',
          display_name: 'Social',
        },
      },
      participant_profiles: {
        [ownerPubkey]: ownerProfile,
        [readerPubkey]: readerProfile,
        [socialPubkey]: socialProfile,
      },
      roster_ops: [ownerOp, readerOp, socialOp],
    };

    expect(sharedFolderAppKeyWriteAuthorization(folder, ownerPubkey)).toBe('authorized');
    expect(sharedFolderAppKeyWriteAuthorization(folder, readerPubkey)).toBe('insufficient_share_role');
    expect(sharedFolderAuthorizedWriterPubkeys(folder)).toEqual([ownerPubkey]);
    expect(sharedFolderAppKeyWriteAuthorization(folder, unknownPubkey)).toBe('unknown_app_key');
    expect(sharedFolderAppKeyWriteAuthorization(folder, socialPubkey)).toBe('not_an_app_key');

    const unboundReader: SharedFolder = structuredClone(folder);
    unboundReader.roster_ops = [ownerOp, unboundReaderOp, socialOp];
    expect(sharedFolderAppKeyWriteAuthorization(unboundReader, readerPubkey)).toBe('unknown_app_key');
    expect(sharedFolderKeyRecipientPubkeys(unboundReader)).not.toContain(readerPubkey);

    const missingMember: SharedFolder = {
      ...folder,
      participant_profiles: {
        ...folder.participant_profiles,
        [unknownPubkey]: '123e4567-e89b-42d3-a456-426614174055',
      },
    };
    expect(sharedFolderAppKeyWriteAuthorization(missingMember, unknownPubkey)).toBe('unknown_app_key');

    const pending: SharedFolder = structuredClone(folder);
    pending.members![readerProfile]!.status = 'pending';
    expect(sharedFolderAppKeyWriteAuthorization(pending, readerPubkey)).toBe('pending_member');

    const revoked: SharedFolder = structuredClone(folder);
    revoked.members![readerProfile]!.status = 'revoked';
    expect(sharedFolderAppKeyWriteAuthorization(revoked, readerPubkey)).toBe('revoked_member');

    const promotedReader: SharedFolder = structuredClone(folder);
    promotedReader.members![readerProfile]!.role = 'editor';
    expect(sharedFolderAppKeyWriteAuthorization(promotedReader, readerPubkey)).toBe('app_key_cannot_write_roots');

    const missingFacet: SharedFolder = structuredClone(promotedReader);
    missingFacet.roster_ops = folder.roster_ops!.filter((op) => op.op_id !== readerOp.op_id);
    expect(sharedFolderAppKeyWriteAuthorization(missingFacet, readerPubkey)).toBe('unknown_app_key');
  });
});
