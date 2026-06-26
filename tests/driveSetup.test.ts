import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { encodeDeviceLinkInvite } from '../src/drive/deviceLink';
import {
  driveRootPath,
  isCompleteDeviceLinkOwnerInput,
  isCompleteShareInviteInput,
  normalizeOwnerNpub,
  shareInvitePayload,
} from '../src/drive/setup';

const pubkey = '0'.repeat(63) + '1';
const npub = nip19.npubEncode(pubkey);
const profileId = '019ed693-4110-7352-8cc3-be90158ba91e';
const currentInviteAdminNpub = 'npub1q5l0vneajh6289vgngswu5wm26qamsjwtyjj2gqlpkuj5zmdedys0y6mt7';
const currentInvitePayload = Buffer.from(JSON.stringify({
  v: 1,
  profileId: '3c089df8-221e-473c-91ec-f771c015c8bd',
  adminAppKeyNpub: currentInviteAdminNpub,
  inviteNpub: nip19.npubEncode('1'.repeat(64)),
})).toString('base64url');
const legacyLinkSecretPayload = Buffer.from(JSON.stringify({
  v: 1,
  profileId: '3c089df8-221e-473c-91ec-f771c015c8bd',
  adminAppKeyNpub: currentInviteAdminNpub,
  linkSecret: 'old-secret',
})).toString('base64url');

describe('drive setup helpers', () => {
  it('normalizes owner npubs', () => {
    expect(normalizeOwnerNpub(npub)).toBe(npub);
    expect(normalizeOwnerNpub(`nostr:${npub}`)).toBe(npub);
  });

  it('normalizes owner hex pubkeys', () => {
    expect(normalizeOwnerNpub(pubkey.toUpperCase())).toBe(npub);
  });

  it('rejects invalid owner keys', () => {
    expect(normalizeOwnerNpub('nsec1bad')).toBeNull();
    expect(normalizeOwnerNpub('')).toBeNull();
  });

  it('opens the native-compatible main tree path', () => {
    expect(driveRootPath(npub)).toBe(`/${npub}/main`);
  });

  it('extracts the admin AppKey npub from canonical IrisProfile invites for owner-only input', () => {
    const invite = encodeDeviceLinkInvite({
      profileId,
      adminAppKeyPubkey: pubkey,
      invitePubkey: '1'.repeat(64),
    });

    expect(invite).toMatch(/^https:\/\/drive\.iris\.to\/invite\//);
    expect(isCompleteDeviceLinkOwnerInput(invite)).toBe(true);
    expect(normalizeOwnerNpub(invite)).toBe(npub);
  });

  it('accepts current drive.iris.to device invite URLs from native apps', () => {
    const invite = `https://drive.iris.to/invite/${currentInvitePayload}`;

    expect(isCompleteDeviceLinkOwnerInput(invite)).toBe(true);
    expect(normalizeOwnerNpub(invite)).toBe(currentInviteAdminNpub);
  });

  it('rejects old link-secret device invite payloads', () => {
    const invite = `https://drive.iris.to/invite/${legacyLinkSecretPayload}`;

    expect(isCompleteDeviceLinkOwnerInput(invite)).toBe(false);
    expect(normalizeOwnerNpub(invite)).toBeNull();
  });

  it('does not accept custom-scheme device invite URLs', () => {
    const legacy = `iris-drive://invite/${currentInvitePayload}`;

    expect(isCompleteDeviceLinkOwnerInput(legacy)).toBe(false);
    expect(normalizeOwnerNpub(legacy)).toBeNull();
  });

  it('rejects legacy link-device URLs as device-link input', () => {
    const legacy = `iris-drive://link-device?owner=${npub}&admin=${npub}&secret=join-secret`;

    expect(isCompleteDeviceLinkOwnerInput(legacy)).toBe(false);
    expect(normalizeOwnerNpub(legacy)).toBeNull();
  });

  it('recognizes share invites without treating them as owner link invites', () => {
    const payload = 'a'.repeat(40);
    const invite = `iris-drive://share-invite/${payload}`;

    expect(isCompleteShareInviteInput(invite)).toBe(true);
    expect(shareInvitePayload(`nostr:${invite}`)).toBe(payload);
    expect(isCompleteDeviceLinkOwnerInput(invite)).toBe(false);
    expect(normalizeOwnerNpub(invite)).toBeNull();
  });
});
