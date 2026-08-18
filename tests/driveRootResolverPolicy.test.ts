import { describe, expect, it } from 'vitest';
import {
  isAuthorizedDriveRootScopeSession,
  driveRootAuthorizationFingerprint,
  driveRootBackfillFilters,
  isActiveDriveRootScopeSession,
  shouldResetDriveRootProjection,
} from '../src/lib/driveRootResolverPolicy';
import { driveRootDTag, KIND_DRIVE_ROOT } from '../src/drive/protocol';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';
const OTHER_PROFILE_ID = '11111111-2222-4333-8444-555555555555';

describe('Drive root resolver policy', () => {
  const session = {
    profileId: PROFILE_ID,
    appKeyPubkey: 'bb',
    status: 'active' as const,
    rosterOps: [{ op_id: 'op-b' }, { op_id: 'op-a' }],
  };

  it('only permits UUID root caches for an active matching identity session', () => {
    expect(isActiveDriveRootScopeSession(PROFILE_ID, session)).toBe(true);
    expect(isActiveDriveRootScopeSession(OTHER_PROFILE_ID, session)).toBe(false);
    expect(isActiveDriveRootScopeSession(PROFILE_ID, null)).toBe(false);
  });

  it('revokes root access when the current AppKey leaves the active roster', () => {
    expect(isAuthorizedDriveRootScopeSession(
      PROFILE_ID,
      session,
      new Set(['aa', session.appKeyPubkey]),
    )).toBe(true);
    expect(isAuthorizedDriveRootScopeSession(
      PROFILE_ID,
      session,
      new Set(['aa']),
    )).toBe(false);
  });

  it('fingerprints roster and authorized AppKey changes independent of ordering', () => {
    const first = driveRootAuthorizationFingerprint(session, new Set(['cc', 'aa']));
    const reordered = driveRootAuthorizationFingerprint(
      { ...session, rosterOps: [...session.rosterOps].reverse() },
      new Set(['aa', 'cc']),
    );
    const revoked = driveRootAuthorizationFingerprint(session, new Set(['aa']));

    expect(first).toBe(reordered);
    expect(revoked).not.toBe(first);
  });

  it('resets an unproven persisted root on the first fingerprint after reload', () => {
    expect(shouldResetDriveRootProjection(undefined, 'authorized-a')).toBe(true);
    expect(shouldResetDriveRootProjection('authorized-a', 'authorized-a')).toBe(false);
    expect(shouldResetDriveRootProjection('authorized-a', 'authorized-b')).toBe(true);
  });

  it('uses one latest-event backfill filter per authorized author', () => {
    expect(driveRootBackfillFilters(PROFILE_ID, 'main', new Set(['cc', 'aa']))).toEqual([
      {
        kinds: [KIND_DRIVE_ROOT],
        authors: ['aa'],
        '#d': [driveRootDTag(PROFILE_ID, 'main')],
        limit: 1,
      },
      {
        kinds: [KIND_DRIVE_ROOT],
        authors: ['cc'],
        '#d': [driveRootDTag(PROFILE_ID, 'main')],
        limit: 1,
      },
    ]);
  });
});
