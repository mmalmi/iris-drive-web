import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import { createIrisIdentitySignerFromNsec } from '@iris/identity';
import {
  createIrisProfileDckRewrapOp,
  projectIrisProfileRoster,
  signIrisProfileRosterOp,
  wrapDriveContentKeyForAppKeys,
} from '../src/drive/protocol';
import { appFacet } from './driveProtocolInterop.helpers';

describe('iris-drive recovery DCK rewrap', () => {
  it('rotates a DCK epoch through a decrypt-capable recovery key for a new app key', async () => {
    const profileId = '123e4567-e89b-42d3-a456-426614174180';
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const recoverySecret = generateSecretKey();
    const recoveryPubkey = getPublicKey(recoverySecret);
    const appKeySecret = generateSecretKey();
    const appKeyPubkey = getPublicKey(appKeySecret);
    const dckPlaintext = 'drive-content-key-v1';

    const bootstrap = signIrisProfileRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      createdAt: 10,
      clientNonce: 'bootstrap-admin',
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 10, 'Admin', true, true),
      },
    });
    const addRecovery = signIrisProfileRosterOp({
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
            can_receive_key_wraps: true,
            can_decrypt_key_epochs: true,
          },
          added_at: 11,
          label: 'Recovery phrase',
        },
      },
    });
    const originalEpoch = signIrisProfileRosterOp({
      signerSecretKey: adminSecret,
      profileId,
      parents: [bootstrap.op_id, addRecovery.op_id],
      createdAt: 12,
      clientNonce: 'rotate-dck-1',
      op: {
        op: 'rotate_key_epoch',
        epoch: 1,
        wrapped_dck: wrapDriveContentKeyForAppKeys(
          adminSecret,
          dckPlaintext,
          [adminPubkey, recoveryPubkey],
        ),
      },
    });
    const addAppKey = signIrisProfileRosterOp({
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

    const rewrap = await createIrisProfileDckRewrapOp({
      profileId,
      signer: createIrisIdentitySignerFromNsec(nip19.nsecEncode(recoverySecret)),
      rosterOps: [bootstrap, addRecovery, originalEpoch],
      appKeyPubkey,
      parentRosterOp: addAppKey,
      createdAt: 14,
      clientNonce: 'rewrap-for-web',
    });

    expect(rewrap?.signer_pubkey).toBe(recoveryPubkey);
    expect(rewrap?.content.op).toMatchObject({
      op: 'rotate_key_epoch',
      epoch: 2,
    });
    const projection = projectIrisProfileRoster(profileId, [
      bootstrap,
      addRecovery,
      originalEpoch,
      addAppKey,
      rewrap!,
    ]);
    const epoch = projection.key_epochs['2'];
    expect(epoch.signed_by_pubkey).toBe(recoveryPubkey);
    expect(Object.keys(epoch.wrapped_dck).sort()).toEqual([
      adminPubkey,
      appKeyPubkey,
      recoveryPubkey,
    ].sort());

    const appConversationKey = nip44.v2.utils.getConversationKey(appKeySecret, recoveryPubkey);
    expect(nip44.v2.decrypt(epoch.wrapped_dck[appKeyPubkey], appConversationKey)).toBe(dckPlaintext);
  });
});
