import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  driveRootPath,
  isCompleteDeviceLinkOwnerInput,
  isCompleteShareInviteInput,
  normalizeOwnerNpub,
  shareInvitePayload,
} from '../src/drive/setup';

const pubkey = '0'.repeat(63) + '1';
const npub = nip19.npubEncode(pubkey);

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

  it('recognizes share invites without treating them as owner link invites', () => {
    const payload = 'a'.repeat(40);
    const invite = `iris-drive://share-invite/${payload}`;

    expect(isCompleteShareInviteInput(invite)).toBe(true);
    expect(shareInvitePayload(`nostr:${invite}`)).toBe(payload);
    expect(isCompleteDeviceLinkOwnerInput(invite)).toBe(false);
    expect(normalizeOwnerNpub(invite)).toBeNull();
  });
});
