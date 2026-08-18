import type { NDKFilter } from 'ndk';
import {
  driveRootDTag,
  KIND_DRIVE_ROOT,
  type NostrIdentityId,
} from '../drive/protocol';

export type DriveRootScopeSession = {
  profileId: NostrIdentityId | string;
  appKeyPubkey: string;
  status: string;
  rosterOps: ReadonlyArray<{ op_id: string }>;
};

export function isActiveDriveRootScopeSession(
  rootScopeId: string,
  session: DriveRootScopeSession | null | undefined,
): session is DriveRootScopeSession {
  return session?.status === 'active' && session.profileId === rootScopeId;
}

export function isAuthorizedDriveRootScopeSession(
  rootScopeId: string,
  session: DriveRootScopeSession | null | undefined,
  authorizedAppKeys: ReadonlySet<string>,
): session is DriveRootScopeSession {
  return isActiveDriveRootScopeSession(rootScopeId, session)
    && authorizedAppKeys.has(session.appKeyPubkey);
}

export function driveRootAuthorizationFingerprint(
  session: DriveRootScopeSession,
  authorizedAppKeys: ReadonlySet<string>,
): string {
  return JSON.stringify({
    profileId: session.profileId,
    appKeyPubkey: session.appKeyPubkey,
    rosterOps: session.rosterOps.map((op) => op.op_id).sort(),
    authorizedAppKeys: [...authorizedAppKeys].sort(),
  });
}

/**
 * A hydrated UUID-root record carries no AppKey provenance. The first
 * authorization snapshot after a page/module reload therefore has to rebuild
 * it just like a later roster change, even when the persisted record has a
 * newer wall-clock timestamp than the authorized projection.
 */
export function shouldResetDriveRootProjection(
  previousFingerprint: string | undefined,
  currentFingerprint: string,
): boolean {
  return previousFingerprint === undefined || previousFingerprint !== currentFingerprint;
}

/**
 * Give every authorized AppKey its own limit-one parameterized-replaceable
 * query. A busy writer therefore cannot consume the result limit before a
 * quiet device's current root is returned.
 */
export function driveRootBackfillFilters(
  rootScopeId: string,
  driveId: string,
  authorizedAppKeys: ReadonlySet<string>,
): NDKFilter[] {
  const dTag = driveRootDTag(rootScopeId, driveId);
  return [...authorizedAppKeys]
    .sort()
    .map((author) => ({
      kinds: [KIND_DRIVE_ROOT],
      authors: [author],
      '#d': [dTag],
      limit: 1,
    }));
}
