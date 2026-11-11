import { describe, expect, it, vi } from 'vitest';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174170';
const SHARE_ID = '223e4567-e89b-42d3-a456-426614174171';
const APP_KEY = 'a'.repeat(64);
const APP_NPUB = 'npub1activeappkey';
const shared = vi.hoisted(() => ({ writableShares: new Set<string>() }));

vi.mock('../src/drive/profileRoute', () => ({
  isEditableDriveRouteScope: (scope: string) => (
    scope === '123e4567-e89b-42d3-a456-426614174170' || shared.writableShares.has(scope)
  ),
}));

import { documentWriteScope } from '../src/lib/yjs/routeScope';

const STATE = { isLoggedIn: true, pubkey: APP_KEY };

describe('where a document is written', () => {
  it('writes into the active Drive under its stable id', () => {
    expect(documentWriteScope(PROFILE_ID, APP_NPUB, STATE)).toBe(PROFILE_ID);
  });

  it('writes into a shared folder only with an editor role', () => {
    expect(documentWriteScope(SHARE_ID, APP_NPUB, STATE)).toBeNull();
    shared.writableShares.add(SHARE_ID);
    expect(documentWriteScope(SHARE_ID, APP_NPUB, STATE)).toBe(SHARE_ID);
    shared.writableShares.clear();
  });

  it('never writes into someone else\'s tree or while signed out', () => {
    expect(documentWriteScope('npub1someoneelse', APP_NPUB, STATE)).toBeNull();
    expect(documentWriteScope(APP_NPUB, APP_NPUB, STATE)).toBe(APP_NPUB);
    expect(documentWriteScope(PROFILE_ID, APP_NPUB, { isLoggedIn: false, pubkey: null })).toBeNull();
    expect(documentWriteScope(null, APP_NPUB, STATE)).toBeNull();
  });
});
