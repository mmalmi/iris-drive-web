import { beforeEach, describe, expect, it, vi } from 'vitest';

const profileId = '123e4567-e89b-42d3-a456-426614174170';
const appKeyPubkey = 'a'.repeat(64);
const npub = 'npub1example';

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

import { activeDriveRootPath } from '../src/drive/profileRoute';

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
});
