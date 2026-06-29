import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import { createNostrIdentitySignerFromNsec } from '@iris/identity';
import {
  createNostrIdentityDckRotateAfterAddOp,
  createNostrIdentityDckRotateAfterRemovalOp,
  createNostrIdentityDckRewrapOp,
  projectNostrIdentityRoster,
  signNostrIdentityRosterOp,
  wrapDriveContentKeyForAppKeys,
} from '../src/drive/protocol';
import { appFacet } from './driveProtocolInterop.helpers';

describe('iris-drive recovery DCK rewrap', () => {
  it('creates an initial DCK epoch when a web profile without one approves a writer app key', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174179';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const appKeySecret = generateSecretKey();
    const appKeyPubkey = getPublicKey(appKeySecret);

    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      createdAt: 10,
      clientNonce: 'bootstrap-admin',
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 10, 'Admin', true, true),
      },
    });
    const addAppKey = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id],
      createdAt: 11,
      clientNonce: 'approve-phone',
      op: {
        op: 'add_facet',
        facet: appFacet(appKeyPubkey, 11, 'Phone', true, false),
      },
    });

    const rotation = await createNostrIdentityDckRotateAfterAddOp({
      profileId,
      signer: createNostrIdentitySignerFromNsec(nip19.nsecEncode(adminSecret)),
      rosterOps: [bootstrap],
      parentRosterOp: addAppKey,
      createdAt: 12,
      clientNonce: 'approve-phone-rotate-dck',
      dckPlaintext: 'drive-content-key-v1',
    });

    expect(rotation.content.op).toMatchObject({
      op: 'rotate_secret_epoch',
      epoch: 1,
    });
    const projection = projectNostrIdentityRoster(profileId, [bootstrap, addAppKey, rotation]);
    expect(projection.active_facets[appKeyPubkey]?.capabilities?.can_admin_profile).toBeFalsy();
    expect(Object.keys(projection.secret_epochs['1'].wrapped_secrets).sort()).toEqual([
      adminPubkey,
      appKeyPubkey,
    ].sort());

    const appConversationKey = nip44.v2.utils.getConversationKey(appKeySecret, adminPubkey);
    expect(nip44.v2.decrypt(projection.secret_epochs['1'].wrapped_secrets[appKeyPubkey], appConversationKey))
      .toBe('drive-content-key-v1');
  });

  it('rotates a DCK epoch through a decrypt-capable recovery key for a new app key', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174180';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const recoverySecret = generateSecretKey();
    const recoveryPubkey = getPublicKey(recoverySecret);
    const appKeySecret = generateSecretKey();
    const appKeyPubkey = getPublicKey(appKeySecret);
    const dckPlaintext = 'drive-content-key-v1';

    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      createdAt: 10,
      clientNonce: 'bootstrap-admin',
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 10, 'Admin', true, true),
      },
    });
    const addRecovery = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id],
      createdAt: 11,
      clientNonce: 'add-recovery',
      op: {
        op: 'add_facet',
        facet: {
          pubkey: recoveryPubkey,
          purposes: ['recovery_phrase'],
          capabilities: {
            can_recover_app_keys: true,
            can_receive_secret_wraps: true,
            can_decrypt_secret_epochs: true,
          },
          added_at: 11,
          label: 'Recovery phrase',
        },
      },
    });
    const originalEpoch = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id],
      createdAt: 12,
      clientNonce: 'rotate-dck-1',
      op: {
        op: 'rotate_secret_epoch',
        epoch: 1,
        wrapped_secrets: wrapDriveContentKeyForAppKeys(
          adminSecret,
          dckPlaintext,
          [adminPubkey, recoveryPubkey],
        ),
      },
    });
    const addAppKey = signNostrIdentityRosterOp({
      signerSecretKey: recoverySecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id, originalEpoch.op_id],
      createdAt: 13,
      clientNonce: 'add-web-app-key',
      op: {
        op: 'add_facet',
        facet: appFacet(appKeyPubkey, 13, 'Drive web', true, false),
      },
    });

    const rewrap = await createNostrIdentityDckRewrapOp({
      profileId,
      signer: createNostrIdentitySignerFromNsec(nip19.nsecEncode(recoverySecret)),
      rosterOps: [bootstrap, addRecovery, originalEpoch],
      appKeyPubkey,
      parentRosterOp: addAppKey,
      createdAt: 14,
      clientNonce: 'rewrap-for-web',
    });

    expect(rewrap?.signer_pubkey).toBe(recoveryPubkey);
    expect(rewrap?.content.op).toMatchObject({
      op: 'rotate_secret_epoch',
      epoch: 2,
    });
    const projection = projectNostrIdentityRoster(profileId, [
      bootstrap,
      addRecovery,
      originalEpoch,
      addAppKey,
      rewrap!,
    ]);
    const epoch = projection.secret_epochs['2'];
    expect(epoch.signed_by_pubkey).toBe(recoveryPubkey);
    expect(Object.keys(epoch.wrapped_secrets).sort()).toEqual([
      adminPubkey,
      appKeyPubkey,
      recoveryPubkey,
    ].sort());

    const appConversationKey = nip44.v2.utils.getConversationKey(appKeySecret, recoveryPubkey);
    expect(nip44.v2.decrypt(epoch.wrapped_secrets[appKeyPubkey], appConversationKey)).toBe(dckPlaintext);
  });

  it('rotates a fresh DCK epoch after recovery removes an app key', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174181';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const recoverySecret = generateSecretKey();
    const recoveryPubkey = getPublicKey(recoverySecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const oldDckPlaintext = 'drive-content-key-v1';
    const newDckPlaintext = 'drive-content-key-v2';

    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      createdAt: 10,
      clientNonce: 'bootstrap-admin',
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 10, 'Admin', true, true),
      },
    });
    const addRecovery = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id],
      createdAt: 11,
      clientNonce: 'add-recovery',
      op: {
        op: 'add_facet',
        facet: {
          pubkey: recoveryPubkey,
          purposes: ['recovery_phrase'],
          capabilities: {
            can_recover_app_keys: true,
            can_receive_secret_wraps: true,
            can_decrypt_secret_epochs: true,
          },
          added_at: 11,
        },
      },
    });
    const addPhone = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id],
      createdAt: 12,
      clientNonce: 'add-phone',
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 12, 'Phone', true, false),
      },
    });
    const originalEpoch = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id, addPhone.op_id],
      createdAt: 13,
      clientNonce: 'rotate-dck-1',
      op: {
        op: 'rotate_secret_epoch',
        epoch: 1,
        wrapped_secrets: wrapDriveContentKeyForAppKeys(
          adminSecret,
          oldDckPlaintext,
          [adminPubkey, recoveryPubkey, phonePubkey],
        ),
      },
    });
    const removePhone = signNostrIdentityRosterOp({
      signerSecretKey: recoverySecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id, addPhone.op_id, originalEpoch.op_id],
      createdAt: 14,
      clientNonce: 'remove-phone',
      op: {
        op: 'tombstone_facet',
        pubkey: phonePubkey,
        reason: 'lost device',
      },
    });

    const rotation = await createNostrIdentityDckRotateAfterRemovalOp({
      profileId,
      signer: createNostrIdentitySignerFromNsec(nip19.nsecEncode(recoverySecret)),
      rosterOps: [bootstrap, addRecovery, addPhone, originalEpoch],
      parentRosterOp: removePhone,
      createdAt: 15,
      clientNonce: 'rotate-after-removal',
      dckPlaintext: newDckPlaintext,
    });

    expect(rotation?.signer_pubkey).toBe(recoveryPubkey);
    expect(rotation?.content.op).toMatchObject({
      op: 'rotate_secret_epoch',
      epoch: 2,
    });
    const projection = projectNostrIdentityRoster(profileId, [
      bootstrap,
      addRecovery,
      addPhone,
      originalEpoch,
      removePhone,
      rotation!,
    ]);
    const epoch = projection.secret_epochs['2'];
    expect(projection.active_facets[phonePubkey]).toBeUndefined();
    expect(projection.tombstones[phonePubkey]?.removed_by_pubkey).toBe(recoveryPubkey);
    expect(Object.keys(epoch.wrapped_secrets).sort()).toEqual([
      adminPubkey,
      recoveryPubkey,
    ].sort());

    const adminConversationKey = nip44.v2.utils.getConversationKey(adminSecret, recoveryPubkey);
    expect(nip44.v2.decrypt(epoch.wrapped_secrets[adminPubkey], adminConversationKey)).toBe(newDckPlaintext);
    expect(epoch.wrapped_secrets[phonePubkey]).toBeUndefined();
  });
});
