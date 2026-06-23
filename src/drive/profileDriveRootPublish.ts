import { toHex, type CID } from '@hashtree/core';
import { getPublicKey } from 'nostr-tools';
import type { IrisIdentitySession } from '@iris/identity';
import { NDKEvent, getCurrentIrisIdentitySession, getSecretKey, ndk } from '../nostr';
import { publishEventWithFallback } from '../lib/nostrPublish';
import {
  buildDriveRootEvent,
  projectIrisProfileRoster,
  type IrisProfileRosterProjection,
} from './protocol';

type SessionProjection = {
  projection: IrisProfileRosterProjection | null;
  activeAppKeyPubkeys: string[];
  keyEpoch: number;
};

function projectSession(session: IrisIdentitySession): SessionProjection {
  let projection: IrisProfileRosterProjection | null = null;
  const activeAppKeyPubkeys = new Set<string>([session.appKeyPubkey]);
  let keyEpoch = 0;

  try {
    projection = projectIrisProfileRoster(session.profileId, session.rosterOps ?? []);
    for (const [pubkey, facet] of Object.entries(projection.active_facets)) {
      if (facet.purposes?.includes('app_key')) {
        activeAppKeyPubkeys.add(pubkey);
      }
    }
    for (const epoch of Object.keys(projection.key_epochs)) {
      const parsed = Number(epoch);
      if (Number.isFinite(parsed)) keyEpoch = Math.max(keyEpoch, parsed);
    }
  } catch (error) {
    console.warn('[driveRoot] Could not project IrisProfile roster for Drive root publish:', error);
  }

  return {
    projection,
    activeAppKeyPubkeys: Array.from(activeAppKeyPubkeys).sort(),
    keyEpoch,
  };
}

function nextDriveRootSequence(profileId: string, driveId: string, appKeyPubkey: string): number {
  const storageKey = `iris:drive-root-seq:${profileId}:${driveId}:${appKeyPubkey}`;
  const previous = Number(localStorage.getItem(storageKey) ?? '0');
  const next = Math.max(
    Number.isFinite(previous) ? previous + 1 : 1,
    Date.now(),
  );
  localStorage.setItem(storageKey, String(next));
  return next;
}

export async function publishIrisProfileDriveRootIfAvailable(
  driveId: string,
  rootCid: CID,
): Promise<boolean> {
  const session = getCurrentIrisIdentitySession();
  const secretKey = getSecretKey();
  if (!session || session.status !== 'active' || !secretKey) return true;
  if (!rootCid.key) {
    console.warn('[driveRoot] Skipping IrisProfile Drive root publish without encrypted root key', {
      profileId: session.profileId,
      driveId,
      rootHash: toHex(rootCid.hash),
    });
    return false;
  }

  const appKeyPubkey = getPublicKey(secretKey);
  if (appKeyPubkey !== session.appKeyPubkey) {
    console.warn('[driveRoot] Skipping IrisProfile Drive root publish because active key differs from session AppKey');
    return false;
  }

  const projected = projectSession(session);
  if (projected.projection && !projected.projection.active_facets[appKeyPubkey]) {
    console.warn('[driveRoot] Skipping IrisProfile Drive root publish because AppKey is not active in roster');
    return false;
  }

  const rawEvent = buildDriveRootEvent({
    deviceSecretKey: secretKey,
    rootScopeId: session.profileId,
    driveId,
    root: rootCid,
    dckGeneration: projected.keyEpoch,
    appKeySeq: nextDriveRootSequence(session.profileId, driveId, appKeyPubkey),
    authorizedAppKeyPubkeys: projected.activeAppKeyPubkeys,
  });

  const event = new NDKEvent(ndk, rawEvent);
  await publishEventWithFallback(event);
  return true;
}
