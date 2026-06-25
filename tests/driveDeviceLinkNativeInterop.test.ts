import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrToolsEvent } from 'nostr-tools';
import { signDeviceLinkRequestEvent } from '@iris/identity';
import { parseDriveDeviceLinkRequestEventForAdmin } from '../src/nostr/auth';

const profileId = '123e4567-e89b-42d3-a456-426614174099';

describe('native app-key-link request interop', () => {
  it('parses encrypted identity fact-event device link requests', async () => {
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const adminAppKeyPubkey = 'a'.repeat(64);
    const event = signDeviceLinkRequestEvent({
      signerSecretKey: deviceSecret,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: device,
        requestedAt: 1_782_377_100,
        label: 'iPhone',
      },
      clientNonce: 'fact-request',
    });

    expect(event.kind).toBe(7368);
    expect(event.content).not.toBe('');
    expect(event.tags).toContainEqual(['p', invitePubkey]);
    expect(event.tags.some((tag) => tag[0] === 'admin_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'key_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'joining_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'link_secret_hash')).toBe(false);

    const parsed = await parseDriveDeviceLinkRequestEventForAdmin(event, {
      profileId,
      adminAppKeyPubkey,
      invitePubkey,
      inviteSecretKey: inviteSecret,
    });

    expect(parsed?.pubkey).toBe(device);
    expect(parsed?.label).toBe('iPhone');
    expect(parsed?.request).toMatchObject({
      profileId,
      adminAppKeyPubkey,
      invitePubkey,
      deviceAppKeyPubkey: device,
      requestedAt: 1_782_377_100,
      label: 'iPhone',
    });
  });

  it('rejects encrypted requests for another invite key', async () => {
    const deviceSecret = generateSecretKey();
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const otherInviteSecret = generateSecretKey();
    const adminAppKeyPubkey = 'a'.repeat(64);
    const event = signDeviceLinkRequestEvent({
      signerSecretKey: deviceSecret,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: getPublicKey(deviceSecret),
        requestedAt: 1_782_377_100,
      },
    });

    await expect(parseDriveDeviceLinkRequestEventForAdmin(event, {
      profileId,
      adminAppKeyPubkey,
      invitePubkey: getPublicKey(otherInviteSecret),
      inviteSecretKey: otherInviteSecret,
    })).resolves.toBeNull();
  });

  it('rejects old public-tag link request events', async () => {
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const legacyEvent = finalizeEvent({
      kind: 7368,
      created_at: 1_782_377_000,
      tags: [
        ['i', profileId, 'subject'],
        ['type', 'nostr_identity_link_request'],
        ['admin_pubkey', 'a'.repeat(64)],
        ['key_pubkey', device],
        ['link_secret_hash', 'old-hash'],
      ],
      content: '',
    }, deviceSecret) as NostrToolsEvent;
    const inviteSecret = generateSecretKey();

    await expect(parseDriveDeviceLinkRequestEventForAdmin(legacyEvent, {
      profileId,
      adminAppKeyPubkey: 'a'.repeat(64),
      invitePubkey: getPublicKey(inviteSecret),
      inviteSecretKey: inviteSecret,
    })).resolves.toBeNull();
  });

  it('rejects old native 30078 app-key-link frames', async () => {
    const inviteSecret = generateSecretKey();
    const oldEvent: NostrToolsEvent = finalizeEvent({
      kind: 30078,
      created_at: 1_782_377_000,
      tags: [
        ['d', `${profileId}/app-key-link-request`],
      ],
      content: JSON.stringify({
        schema: 1,
        profile_id: profileId,
        app_key_pubkey: getPublicKey(generateSecretKey()),
        link_secret: 'native-join-secret',
      }),
    }, generateSecretKey()) as NostrToolsEvent;

    await expect(parseDriveDeviceLinkRequestEventForAdmin(oldEvent, {
      profileId,
      adminAppKeyPubkey: 'a'.repeat(64),
      invitePubkey: getPublicKey(inviteSecret),
      inviteSecretKey: inviteSecret,
    })).resolves.toBeNull();
  });
});
