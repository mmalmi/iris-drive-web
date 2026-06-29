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
import {
  DRIVE_DEVICE_LABEL_SCHEMA,
  decryptDriveDeviceLabelsWithDck,
  encryptDriveDeviceLabelsWithDck,
  encryptedDeviceLabelPayloadsFromEventJson,
} from '../src/drive/deviceLabels';


describe('iris-drive protocol profile rosters', () => {
  it('builds signed NostrIdentity roster ops and self-acceptance events', () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174070';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phoneSecret = generateSecretKey();
    const phonePubkey = getPublicKey(phoneSecret);

    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      clientNonce: '123e4567-e89b-42d3-a456-426614174170',
      createdAt: 1_700_001_099,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 1_700_001_099, 'Admin', true, true),
      },
    });
    const addEvent = buildNostrIdentityRosterOpEvent({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id],
      clientNonce: '123e4567-e89b-42d3-a456-426614174071',
      createdAt: 1_700_001_100,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 1_700_001_100, 'Phone', true, false),
      },
    });

    expect(verifyEvent(addEvent)).toBe(true);
    expect(addEvent.kind).toBe(KIND_NOSTR_IDENTITY_ROSTER_OP);
    expect(addEvent.pubkey).toBe(adminPubkey);
    expect(addEvent.content).toBe('');
    expect(addEvent.tags.some(([name]) => name === 'd')).toBe(false);
    expect(addEvent.tags).toContainEqual(['i', profileId, 'subject']);
    expect(addEvent.tags).toContainEqual(['type', 'nostr_identity_roster_op']);
    expect(addEvent.tags).toContainEqual(['op', 'add_key']);
    expect(addEvent.tags).toContainEqual(['key_pubkey', phonePubkey]);
    expect(addEvent.tags).toContainEqual(['p', phonePubkey]);

    const parsedAdd = parseNostrIdentityRosterOpEvent(addEvent);
    expect(parsedAdd.content).toMatchObject({
      schema: NOSTR_IDENTITY_ROSTER_SCHEMA,
      profile_id: profileId,
      actor_pubkey: adminPubkey,
      parents: [bootstrap.op_id],
      created_at: 1_700_001_100,
    });
    expect(nostrIdentityRosterParentIds([bootstrap, parsedAdd])).toEqual([bootstrap.op_id, parsedAdd.op_id]);

    const acceptance = signNostrIdentityFacetAcceptance({
      signerSecretKey: phoneSecret,
      profileId,
      rosterOpId: parsedAdd.op_id,
      purposes: ['app_key'],
      clientNonce: '123e4567-e89b-42d3-a456-426614174072',
      acceptedAt: 1_700_001_101,
    });
    const acceptanceEvent = JSON.parse(acceptance.event_json);

    expect(acceptanceEvent.content).toBe('');
    expect(acceptanceEvent.tags).toContainEqual(['type', 'nostr_identity_key_acceptance']);
    expect(acceptanceEvent.tags).toContainEqual(['key_pubkey', phonePubkey]);
    expect(acceptanceEvent.tags).toContainEqual(['roster_op_id', parsedAdd.op_id]);
    expect(acceptance.signer_pubkey).toBe(phonePubkey);
    expect(projectNostrIdentityRoster(profileId, [bootstrap, parsedAdd]).active_facets[phonePubkey]).toBeTruthy();
  });

  it('signs NostrIdentity roster ops with accepted projection parents', () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174073';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const first = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      clientNonce: '123e4567-e89b-42d3-a456-426614174074',
      createdAt: 1_700_001_102,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 1_700_001_102, 'Admin', true, true),
      },
    });
    const second = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: nostrIdentityRosterParentIds([first]),
      clientNonce: '123e4567-e89b-42d3-a456-426614174075',
      createdAt: 1_700_001_103,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 1_700_001_103, 'Phone', false, false),
      },
    });

    expect(second.content.parents).toEqual([first.op_id]);
    expect(nostrIdentityRosterParentIds([first, second])).toEqual([first.op_id, second.op_id]);
  });

  it('carries compact encrypted device labels without public facet labels', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174175';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const dckPlaintext = 'f'.repeat(64);
    const encryptedDeviceLabels = await encryptDriveDeviceLabelsWithDck({
      schema: DRIVE_DEVICE_LABEL_SCHEMA,
      profileId,
      secretEpoch: 1,
      labels: {
        [adminPubkey]: 'Chrome on macOS',
        [phonePubkey]: 'Firefox on Linux',
      },
      updatedAt: 1_700_001_103,
    }, dckPlaintext);

    const addEvent = buildNostrIdentityRosterOpEvent({
      signerSecretKey: adminSecret,
      profileId,
      clientNonce: '123e4567-e89b-42d3-a456-426614174176',
      createdAt: 1_700_001_103,
      encryptedDeviceLabels,
      op: {
        op: 'add_facet',
        facet: {
          pubkey: phonePubkey,
          purposes: ['app_key'],
          capabilities: { can_write_roots: true },
          added_at: 1_700_001_103,
          label: 'Firefox on Linux',
        },
      },
    });

    expect(verifyEvent(addEvent)).toBe(true);
    expect(addEvent.tags).toContainEqual(['encrypted_device_labels', encryptedDeviceLabels]);
    expect(JSON.stringify(addEvent.tags)).not.toContain('Chrome on macOS');
    expect(JSON.stringify(addEvent.tags)).not.toContain('Firefox on Linux');
    expect(addEvent.tags.some(([name]) => name === 'key_label')).toBe(false);

    const [payload] = encryptedDeviceLabelPayloadsFromEventJson(JSON.stringify(addEvent));
    const decrypted = await decryptDriveDeviceLabelsWithDck(payload, dckPlaintext);

    expect(payload).toBe(encryptedDeviceLabels);
    expect(decrypted).toMatchObject({
      schema: DRIVE_DEVICE_LABEL_SCHEMA,
      profileId,
      secretEpoch: 1,
      labels: {
        [adminPubkey]: 'Chrome on macOS',
        [phonePubkey]: 'Firefox on Linux',
      },
      updatedAt: 1_700_001_103,
    });
    const parsedOp = parseNostrIdentityRosterOpEvent(addEvent).content.op;
    expect(parsedOp).toMatchObject({
      op: 'add_facet',
      facet: {
        pubkey: phonePubkey,
      },
    });
    expect(parsedOp.op === 'add_facet' ? parsedOp.facet.label : undefined).toBeUndefined();
  });

  it('rejects tampered NostrIdentity roster fields during projection', () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174076';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const op = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      clientNonce: '123e4567-e89b-42d3-a456-426614174077',
      createdAt: 1_700_001_104,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 1_700_001_104, 'Admin', true, true),
      },
    });
    const tampered = structuredClone(op);
    if (tampered.content.op.op === 'add_facet') {
      tampered.content.op.facet.added_at += 1;
    }

    const projection = projectNostrIdentityRoster(profileId, [tampered]);

    expect(projection.accepted_op_ids).toEqual([]);
    expect(projection.rejected_op_ids).toEqual([op.op_id]);
    expect(projection.active_facets).toEqual({});
  });

  it('rejects tampered share member roster fields during projection', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const alicePubkey = getPublicKey(generateSecretKey());
    const shareId = '123e4567-e89b-42d3-a456-426614174078';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174079';
    const aliceProfile = '123e4567-e89b-42d3-a456-426614174080';
    const ownerRosterOp = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret,
      profileId: shareId,
      createdAt: 1_700_001_105,
      op: {
        op: 'add_facet',
        facet: appFacet(ownerPubkey, 1_700_001_105, 'Owner', true, true, ownerProfile),
      },
    });
    const aliceRosterOp = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret,
      profileId: shareId,
      parents: [ownerRosterOp.op_id],
      createdAt: 1_700_001_106,
      op: {
        op: 'add_facet',
        facet: appFacet(alicePubkey, 1_700_001_106, 'Alice phone', true, false, aliceProfile),
      },
    });
    const ownerMemberOp = signedShareMemberOp(
      ownerSecret,
      shareId,
      1_700_001_107,
      {
        op: 'grant_member',
        member: {
          profile_id: ownerProfile,
          role: 'admin',
          status: 'active',
          display_name: 'Owner',
        },
      },
      [],
      [ownerRosterOp.op_id],
    );
    const aliceMemberOp = signedShareMemberOp(
      ownerSecret,
      shareId,
      1_700_001_108,
      {
        op: 'grant_member',
        member: {
          profile_id: aliceProfile,
          role: 'editor',
          status: 'active',
          display_name: 'Alice',
        },
      },
      [ownerMemberOp.op_id],
      [aliceRosterOp.op_id],
    );
    const tamperedAliceMemberOp = structuredClone(aliceMemberOp);
    if (tamperedAliceMemberOp.content.op.op === 'grant_member') {
      tamperedAliceMemberOp.content.op.member.display_name = 'Forged Alice';
    }
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: ownerProfile,
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
      local_role: 'admin',
      members: {},
      participant_profiles: {},
      roster_ops: [ownerRosterOp, aliceRosterOp],
      member_ops: [ownerMemberOp, tamperedAliceMemberOp],
    };

    const memberProjection = projectSharedFolderMemberRoster(folder);

    expect(memberProjection.accepted_op_ids).toEqual([ownerMemberOp.op_id]);
    expect(memberProjection.rejected_op_ids).toEqual([aliceMemberOp.op_id]);
    expect(memberProjection.members[aliceProfile]).toBeUndefined();
    expect(sharedFolderAppKeyWriteAuthorization(folder, alicePubkey)).toBe('unknown_member');
  });
});
