import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  acceptShareInviteForProfile,
  acceptedShareRecordFromBundle,
  addShortcutToAcceptedShares,
  defaultShareShortcutPath,
  projectAcceptedShareViews,
  upsertAcceptedShare,
} from '../src/drive/shareLibrary';
import {
  KIND_SHARE_MEMBER_ROSTER_OP,
  SHARE_INVITE_PREFIX,
  SHARE_MEMBER_ROSTER_SCHEMA,
  parseShareMemberRosterOpEvent,
  shareMemberRosterOpDTag,
  signNostrIdentityRosterOp,
  type ShareMemberRosterOp,
  type ShareInviteBundle,
  type SharedFolder,
  type SignedShareMemberRosterOp,
} from '../src/drive/protocol';

describe('drive share library', () => {
  it('accepts invite bundles as Shared with me records and projects shortcuts', () => {
    const shareId = '123e4567-e89b-42d3-a456-426614174101';
    const ownerProfile = '123e4567-e89b-42d3-a456-426614174102';
    const recipientProfile = '123e4567-e89b-42d3-a456-426614174103';
    const ownerSecret = generateSecretKey();
    const ownerAppKey = getPublicKey(ownerSecret);
    const recipientSecret = generateSecretKey();
    const recipientAppKey = getPublicKey(recipientSecret);
    const ownerOp = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret,
      profileId: shareId,
      createdAt: 10,
      op: {
        op: 'add_facet',
        facet: appFacet(ownerAppKey, 10, true, true, ownerProfile),
      },
    });
    const recipientOp = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret,
      profileId: shareId,
      parents: [ownerOp.op_id],
      createdAt: 11,
      op: {
        op: 'add_facet',
        facet: appFacet(recipientAppKey, 11, false, false, recipientProfile),
      },
    });
    const epochOp = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret,
      profileId: shareId,
      parents: [ownerOp.op_id, recipientOp.op_id],
      createdAt: 12,
      op: {
        op: 'rotate_secret_epoch',
        epoch: 1,
        wrapped_secrets: { [ownerAppKey]: 'owner-wrap', [recipientAppKey]: 'recipient-wrap' },
      },
    });
    const ownerMemberOp = signedShareMemberOp(ownerSecret, shareId, 13, {
      op: 'grant_member',
      member: {
        profile_id: ownerProfile,
        role: 'admin',
        status: 'active',
        display_name: 'Owner',
      },
    }, [], [ownerOp.op_id]);
    const recipientMemberOp = signedShareMemberOp(ownerSecret, shareId, 14, {
      op: 'grant_member',
      member: {
        profile_id: recipientProfile,
        role: 'reader',
        status: 'active',
        display_name: 'Alice',
      },
    }, [ownerMemberOp.op_id], [ownerOp.op_id, recipientOp.op_id]);
    const folder: SharedFolder = {
      share_id: shareId,
      owner_profile_id: ownerProfile,
      source_path: 'Projects/Alpha',
      display_name: 'Alpha',
      local_role: 'reader',
      members: {
        [ownerProfile]: {
          profile_id: ownerProfile,
          role: 'admin',
          status: 'active',
          display_name: 'Owner',
        },
        [recipientProfile]: {
          profile_id: recipientProfile,
          role: 'reader',
          status: 'active',
          display_name: 'Alice',
        },
      },
      participant_profiles: {},
      roster_ops: [ownerOp, recipientOp, epochOp],
    };
    const cachelessFolder: SharedFolder = {
      ...folder,
      members: {},
      member_ops: [ownerMemberOp, recipientMemberOp],
    };
    const bundle: ShareInviteBundle = {
      schema: 1,
      shared_folder: folder,
      recipient_profile_id: recipientProfile,
      role: 'reader',
      created_at: 1_700_010_000,
    };
    const cachelessBundle: ShareInviteBundle = {
      ...bundle,
      shared_folder: cachelessFolder,
    };
    const payload = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64url');
    const cachelessPayload = Buffer.from(JSON.stringify(cachelessBundle), 'utf8').toString('base64url');

    const accepted = acceptedShareRecordFromBundle(bundle, payload, 1_700_010_010);
    expect(accepted.share_id).toBe(shareId);
    expect(accepted.local_profile_id).toBe(recipientProfile);
    expect(acceptedShareRecordFromBundle(bundle, payload, 1_700_010_010, recipientProfile).local_profile_id)
      .toBe(recipientProfile);
    expect(() => acceptedShareRecordFromBundle(bundle, payload, 1_700_010_010, ownerProfile))
      .toThrow(/not for NostrIdentity/);
    const acceptedCacheless = acceptedShareRecordFromBundle(
      cachelessBundle,
      cachelessPayload,
      1_700_010_010,
      recipientProfile,
    );
    expect(projectAcceptedShareViews([acceptedCacheless])[0]!.view.local_role).toBe('reader');
    expect(acceptShareInviteForProfile(`${SHARE_INVITE_PREFIX}${payload}`, recipientProfile, 1_700_010_011))
      .toMatchObject({ share_id: shareId, local_profile_id: recipientProfile });
    expect(acceptShareInviteForProfile(
      `${SHARE_INVITE_PREFIX}${cachelessPayload}`,
      recipientProfile,
      1_700_010_011,
    )).toMatchObject({ share_id: shareId, local_profile_id: recipientProfile });
    expect(() => acceptShareInviteForProfile(`${SHARE_INVITE_PREFIX}${payload}`, ownerProfile, 1_700_010_012))
      .toThrow(/not for NostrIdentity/);

    const views = projectAcceptedShareViews([accepted]);
    expect(views[0]!.local_app_key_pubkey).toBe(recipientAppKey);
    expect(views[0]!.view).toMatchObject({
      display_name: 'Alpha',
      local_role: 'reader',
      local_role_label: 'Reader',
      key_status: 'available',
      key_status_label: 'Available',
      missing_key_wrap_count: 0,
      shared_with_me_path: 'Shared with me/Alpha',
    });

    const shortcutResult = addShortcutToAcceptedShares([accepted], shareId);
    expect(shortcutResult.shortcut).toEqual({
      share_id: shareId,
      path: 'My Drive/Alpha',
      target_path: 'Shared with me/Alpha',
    });
    expect(projectAcceptedShareViews(shortcutResult.records)[0]!.view.shortcut_paths).toEqual(['My Drive/Alpha']);

    const refreshed = upsertAcceptedShare(shortcutResult.records, {
      ...accepted,
      accepted_at: 1_700_010_100,
    });
    expect(refreshed[0]!.accepted_at).toBe(1_700_010_100);
    expect(refreshed[0]!.shortcuts).toEqual(shortcutResult.records[0]!.shortcuts);
    expect(defaultShareShortcutPath({ ...folder, display_name: '../Alpha' })).toBe('My Drive/.._Alpha');
    expect(`${SHARE_INVITE_PREFIX}${payload}`).toContain('/share-invite/');
  });
});

function signedShareMemberOp(
  signerSecretKey: Uint8Array,
  shareId: string,
  createdAt: number,
  op: ShareMemberRosterOp,
  parents: string[] = [],
  keyRosterParents: string[] = [],
): SignedShareMemberRosterOp {
  const signerPubkey = getPublicKey(signerSecretKey);
  const clientNonce = `${createdAt}-member-op`;
  const event = finalizeEvent({
    kind: KIND_SHARE_MEMBER_ROSTER_OP,
    content: JSON.stringify({
      schema: SHARE_MEMBER_ROSTER_SCHEMA,
      share_id: shareId,
      actor_pubkey: signerPubkey,
      parents,
      key_roster_parents: keyRosterParents,
      client_nonce: clientNonce,
      created_at: createdAt,
      op,
    }),
    created_at: createdAt,
    tags: [
      ['d', shareMemberRosterOpDTag(shareId, clientNonce)],
      ['i', shareId],
      ['p', signerPubkey],
    ],
  }, signerSecretKey);
  return parseShareMemberRosterOpEvent(event);
}

function appFacet(
  pubkey: string,
  addedAt: number,
  canWrite: boolean,
  canAdmin: boolean,
  profileId: string,
) {
  return {
    pubkey,
    profile_id: profileId,
    purposes: ['app_key' as const],
    capabilities: {
      can_write_roots: canWrite,
      can_admin_profile: canAdmin,
      can_receive_secret_wraps: true,
      can_decrypt_secret_epochs: true,
    },
    added_at: addedAt,
    label: 'AppActor',
  };
}
