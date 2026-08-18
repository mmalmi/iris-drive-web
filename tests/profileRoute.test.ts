import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';

const profileId = '123e4567-e89b-42d3-a456-426614174170';
const appKeyPubkey = 'a'.repeat(64);
const npub = nip19.npubEncode(appKeyPubkey);
const otherNpub = nip19.npubEncode('b'.repeat(64));

const mocks = vi.hoisted(() => ({
  session: null as {
    status: 'active';
    profileId: string;
    appKeyPubkey: string;
  } | null,
}));

vi.mock('../src/nostr/auth', () => ({
  getCurrentNostrIdentitySession: () => mocks.session,
}));

import { activeDriveRootPath, editableTreeRoutePubkey } from '../src/drive/profileRoute';

describe('activeDriveRootPath', () => {
  beforeEach(() => {
    mocks.session = null;
  });

  it('points an active Drive profile to its main directory', () => {
    mocks.session = { status: 'active', profileId, appKeyPubkey };

    expect(activeDriveRootPath({ isLoggedIn: true, pubkey: appKeyPubkey, npub })).toBe(`/${profileId}/main`);
  });

  it('uses the logged-in npub when there is no Drive profile session', () => {
    expect(activeDriveRootPath({ isLoggedIn: true, pubkey: appKeyPubkey, npub })).toBe(`/${npub}/main`);
  });

  it('keeps signed-out users on the setup home page', () => {
    expect(activeDriveRootPath({ isLoggedIn: false, pubkey: null, npub: null })).toBe('/');
  });

  it('recognizes the active Drive profile UUID as an editable tree route', () => {
    mocks.session = { status: 'active', profileId, appKeyPubkey };

    expect(editableTreeRoutePubkey(profileId, {
      isLoggedIn: true,
      pubkey: appKeyPubkey,
    })).toBe(appKeyPubkey);
  });

  it('recognizes only the signed-in AppKey npub as an editable legacy route', () => {
    expect(editableTreeRoutePubkey(npub, {
      isLoggedIn: true,
      pubkey: appKeyPubkey,
    })).toBe(appKeyPubkey);
    expect(editableTreeRoutePubkey(otherNpub, {
      isLoggedIn: true,
      pubkey: appKeyPubkey,
    })).toBeNull();
  });

  it('rejects stale profile UUIDs and signed-out routes', () => {
    mocks.session = { status: 'active', profileId, appKeyPubkey };

    expect(editableTreeRoutePubkey('223e4567-e89b-42d3-a456-426614174170', {
      isLoggedIn: true,
      pubkey: appKeyPubkey,
    })).toBeNull();
    expect(editableTreeRoutePubkey(profileId, {
      isLoggedIn: false,
      pubkey: appKeyPubkey,
    })).toBeNull();
  });
});
