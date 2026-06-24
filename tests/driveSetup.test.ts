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
const currentInvitePayload = 'eyJ2IjoxLCJwcm9maWxlSWQiOiIzYzA4OWRmOC0yMjFlLTQ3M2MtOTFlYy1mNzcxYzAxNWM4YmQiLCJhZG1pbkFwcEtleU5wdWIiOiJucHViMXE1bDB2bmVhamg2Mjg5dmduZ3N3dTV3bTI2cWFtc2p3dHlqajJncWxwa3VqNXptZGVkeXMweTZtdDciLCJsaW5rU2VjcmV0IjoiazV3NUpMR2hUQ09sSWdPQUtpRnUtUSJ9';
const currentInviteAdminNpub = 'npub1q5l0vneajh6289vgngswu5wm26qamsjwtyjj2gqlpkuj5zmdedys0y6mt7';

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

  it('routes canonical IrisProfile invites through the admin AppKey until roots are UUID scoped', () => {
    const invite = encodeDeviceLinkInvite({
      profileId,
      adminAppKeyPubkey: pubkey,
      linkSecret: 'join-secret',
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
