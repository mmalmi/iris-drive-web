import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools';
import { toHex } from '@hashtree/core';
import {
  D_TAG_APP_KEYS,
  IRIS_PROFILE_ROSTER_SCHEMA,
  KIND_APP_KEYS,
  KIND_DRIVE_ROOT,
  KIND_IRIS_PROFILE_ROSTER_OP,
  KIND_LEGACY_DRIVE_ROOT,
  KIND_SHARE_ROSTER_CHECKPOINT,
  SHARE_INVITE_PREFIX,
  buildAppKeysEvent,
  buildDriveRootEvent,
  buildIrisProfileRosterOpEvent,
  driveRootDTag,
  encodeShareInvite,
  irisProfileRosterOpDTag,
  irisProfileRosterParentIds,
  isDriveRootEventNewer,
  parseAppKeysEvent,
  parseDriveRootEventForDevice,
  parseDriveRootEventPreview,
  parseIrisProfileRosterOpEvent,
  parseShareInvite,
  projectIrisProfileRoster,
  projectSharedFolderMemberRoster,
  projectSharedFolderView,
  resolveShareRecipientFromEvidence,
  resolveShareRecipientFromProfileEvidence,
  sharedFolderAppKeyWriteAuthorization,
  sharedFolderAuthorizedWriterPubkeys,
  sharedFolderKeyRecipientPubkeys,
  sharedFolderFromInviteForProfile,
  shareRecipientsForResolvedRecipient,
  signIrisProfileFacetAcceptance,
  signIrisProfileRosterOp,
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


describe('iris-drive protocol root events', () => {
  it('models identity ownership separately from the app key that edits a drive', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const appSecret = generateSecretKey();
    const appPubkey = getPublicKey(appSecret);

    const wrappedDck = wrapDriveContentKeyForAppKeys(
      ownerSecret,
      '0123456789abcdef0123456789abcdef',
      [appPubkey],
    );
    const event = buildAppKeysEvent({
      owner_pubkey: ownerPubkey,
      created_at: 1_700_000_000,
      app_keys: [{ pubkey: appPubkey, added_at: 1_700_000_000, label: 'drive web' }],
      dck_generation: 1,
      wrapped_dck: wrappedDck,
    }, ownerSecret);

    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(KIND_APP_KEYS);
    expect(event.pubkey).toBe(ownerPubkey);
    expect(event.tags).toContainEqual(['d', D_TAG_APP_KEYS]);

    const parsed = parseAppKeysEvent(event);
    expect(parsed.owner_pubkey).toBe(ownerPubkey);
    expect(parsed.wrapped_dck[appPubkey]).toBeTruthy();
    expect(parsed.wrapped_dck[appPubkey]).not.toContain('0123456789abcdef');
    expect(parsed.app_keys).toEqual([
      { pubkey: appPubkey, added_at: 1_700_000_000, label: 'drive web' },
    ]);
  });

  it('builds app-key-signed drive roots that an authorized device can unwrap', () => {
    const ownerPubkey = getPublicKey(generateSecretKey());
    const appSecret = generateSecretKey();
    const appPubkey = getPublicKey(appSecret);
    const readerSecret = generateSecretKey();
    const readerPubkey = getPublicKey(readerSecret);
    const root = encryptedRoot('12', '34');

    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      ownerPubkeyHex: ownerPubkey,
      driveId: 'main',
      root,
      dckGeneration: 7,
      deviceSeq: 2,
      authorizedDevicePubkeys: [readerPubkey],
      publishedAt: 1_700_000_123,
      parents: [{ device_id: appPubkey, device_seq: 1, root_cid: 'parent-root-cid' }],
      observed: {
        [readerPubkey]: { device_seq: 4, root_cid: 'reader-root-cid' },
      },
    });

    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(KIND_DRIVE_ROOT);
    expect(event.pubkey).toBe(appPubkey);
    expect(event.tags).toContainEqual(['d', driveRootDTag(ownerPubkey, 'main')]);

    const content = JSON.parse(event.content);
    expect(content.root_hash).toBe(toHex(root.hash));
    expect(content.root_key_wraps[appPubkey]).toBeTruthy();
    expect(content.root_key_wraps[readerPubkey]).toBeTruthy();
    expect(event.content).not.toContain(toHex(root.key!));

    const preview = parseDriveRootEventPreview(event);
    expect(preview).toMatchObject({
      device_pubkey_hex: appPubkey,
      owner_pubkey_hex: ownerPubkey,
      drive_id: 'main',
      dck_generation: 7,
      device_seq: 2,
      published_at: 1_700_000_123,
    });

    const parsedForReader = parseDriveRootEventForDevice(event, readerSecret);
    expect(parsedForReader.root.hash).toEqual(root.hash);
    expect(parsedForReader.root.key).toEqual(root.key);
    expect(parsedForReader.rootRef.parents).toEqual([
      { device_id: appPubkey, device_seq: 1, root_cid: 'parent-root-cid' },
    ]);
  });

  it('still accepts legacy 30079 drive root events while publishing 30078', () => {
    const ownerPubkey = getPublicKey(generateSecretKey());
    const appSecret = generateSecretKey();
    const appPubkey = getPublicKey(appSecret);
    const root = encryptedRoot('42', '43');
    const conversationKey = nip44.v2.utils.getConversationKey(appSecret, appPubkey);
    const wrappedRootKey = nip44.v2.encrypt(toHex(root.key!), conversationKey);

    const event = finalizeEvent({
      kind: KIND_LEGACY_DRIVE_ROOT,
      content: JSON.stringify({
        root_hash: toHex(root.hash),
        root_key_wraps: { [appPubkey]: wrappedRootKey },
        dck_generation: 1,
      }),
      created_at: 1_700_000_124,
      tags: [['d', driveRootDTag(ownerPubkey, 'main')]],
    }, appSecret);

    expect(event.kind).toBe(KIND_LEGACY_DRIVE_ROOT);
    const parsed = parseDriveRootEventForDevice(event, appSecret);
    expect(parsed.root.hash).toEqual(root.hash);
    expect(parsed.root.key).toEqual(root.key);
  });

  it('orders same-second drive root revisions by device sequence', () => {
    const ownerPubkey = getPublicKey(generateSecretKey());
    const appSecret = generateSecretKey();

    const older = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      ownerPubkeyHex: ownerPubkey,
      driveId: 'main',
      root: encryptedRoot('20', '21'),
      dckGeneration: 1,
      deviceSeq: 1,
      authorizedDevicePubkeys: [],
      publishedAt: 1_700_000_200,
    });

    const newer = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      ownerPubkeyHex: ownerPubkey,
      driveId: 'main',
      root: encryptedRoot('22', '23'),
      dckGeneration: 1,
      deviceSeq: 2,
      authorizedDevicePubkeys: [],
      publishedAt: 1_700_000_200,
    });

    expect(isDriveRootEventNewer(newer, older)).toBe(true);
    expect(isDriveRootEventNewer(older, newer)).toBe(false);
  });

  it('builds UUID-scoped AppKey drive roots for IrisProfile and share scopes', () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174000';
    const appSecret = generateSecretKey();
    const appPubkey = getPublicKey(appSecret);
    const root = encryptedRoot('30', '31');

    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: profileId,
      driveId: 'main',
      root,
      dckGeneration: 2,
      appKeySeq: 8,
      authorizedAppKeyPubkeys: [],
      publishedAt: 1_700_001_000,
    });

    expect(event.tags).toContainEqual(['d', driveRootDTag(profileId, 'main')]);
    const preview = parseDriveRootEventPreview(event);
    expect(preview).toMatchObject({
      app_key_pubkey_hex: appPubkey,
      root_scope_id: profileId,
      owner_pubkey_hex: profileId,
      app_key_seq: 8,
      device_seq: 8,
    });
  });
});
