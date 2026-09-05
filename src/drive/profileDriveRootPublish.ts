import { toHex, type CID } from '@hashtree/core';
import { getPublicKey } from 'nostr-tools';
import type { NostrIdentitySession } from './deviceLink';
import { NDKEvent, getCurrentNostrIdentitySession, getSecretKey, ndk } from '../nostr';
import { publishEventWithFallback } from '../lib/nostrPublish';
import { profileDriveProjection } from './profileDriveProjection';
import {
  buildDriveRootEvent,
  parseDriveRootEventForDevice,
  projectNostrIdentityRoster,
  type NostrIdentityRosterProjection,
} from './protocol';

type SessionProjection = {
  projection: NostrIdentityRosterProjection | null;
  activeAppKeyPubkeys: string[];
  keyEpoch: number;
};

function projectSession(session: NostrIdentitySession): SessionProjection {
  let projection: NostrIdentityRosterProjection | null = null;
  const activeAppKeyPubkeys = new Set<string>([session.appKeyPubkey]);
  let keyEpoch = 0;

  try {
    projection = projectNostrIdentityRoster(session.profileId, session.rosterOps ?? []);
    for (const [pubkey, facet] of Object.entries(projection.active_facets)) {
      if (facet.purposes?.includes('app_key')) {
        activeAppKeyPubkeys.add(pubkey);
      }
    }
    for (const epoch of Object.keys(projection.secret_epochs)) {
      const parsed = Number(epoch);
      if (Number.isFinite(parsed)) keyEpoch = Math.max(keyEpoch, parsed);
    }
  } catch (error) {
    console.warn('[driveRoot] Could not project NostrIdentity roster for Drive root publish:', error);
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
  const next = Number.isFinite(previous) && previous > 0 ? previous + 1 : 1;
  localStorage.setItem(storageKey, String(next));
  return next;
}

function nextDriveRootPublishedAt(profileId: string, driveId: string, appKeyPubkey: string): number {
  const storageKey = `iris:drive-root-created-at:${profileId}:${driveId}:${appKeyPubkey}`;
  const previous = Number(localStorage.getItem(storageKey) ?? '0');
  const now = Math.floor(Date.now() / 1000);
  const next = Math.max(
    now,
    Number.isFinite(previous) ? previous + 1 : 1,
  );
  localStorage.setItem(storageKey, String(next));
  return next;
}

export async function publishNostrIdentityDriveRootIfAvailable(
  driveId: string,
  rootCid: CID,
  options: { publishedAt?: number; publishedAtMs?: number; appKeySeq?: number } = {},
): Promise<boolean> {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  if (!session || session.status !== 'active' || !secretKey) return true;
  if (!rootCid.key) {
    console.warn('[driveRoot] Skipping NostrIdentity Drive root publish without encrypted root key', {
      profileId: session.profileId,
      driveId,
      rootHash: toHex(rootCid.hash),
    });
    return false;
  }

  const appKeyPubkey = getPublicKey(secretKey);
  if (appKeyPubkey !== session.appKeyPubkey) {
    console.warn('[driveRoot] Skipping NostrIdentity Drive root publish because active key differs from session AppKey');
    return false;
  }

  const projected = projectSession(session);
  if (projected.projection && !projected.projection.active_facets[appKeyPubkey]) {
    console.warn('[driveRoot] Skipping NostrIdentity Drive root publish because AppKey is not active in roster');
    return false;
  }

  const previousContribution = profileDriveProjection.contributionRoot(
    session.profileId,
    driveId,
    appKeyPubkey,
  );
  const [{ getTree }, { prepareProfileDriveRootForPublish }] = await Promise.all([
    import('../store'),
    import('./profileDriveMutation'),
  ]);
  const publishRoot = await prepareProfileDriveRootForPublish(
    getTree(),
    rootCid,
    previousContribution,
  );
  // A relay root is useful to another device only after its exact block graph
  // is durable. Keep the registry dirty so its normal retry loop can try again
  // instead of announcing an unreadable root.
  const { getWorkerAdapter } = await import('../workerAdapter');
  const adapter = getWorkerAdapter();
  if (!adapter) {
    console.warn('[driveRoot] Cannot publish Drive root before the worker adapter is ready');
    return false;
  }
  let upload: Awaited<ReturnType<typeof adapter.pushToBlossom>>;
  try {
    upload = await adapter.pushToBlossom(publishRoot.hash, publishRoot.key, driveId);
  } catch (error) {
    console.warn('[driveRoot] Could not durably upload Drive root before publish:', error);
    return false;
  }
  if (upload.failed > 0) {
    console.warn(`[driveRoot] Refusing to publish Drive root with ${upload.failed} unavailable block(s)`);
    return false;
  }

  const rawEvent = buildDriveRootEvent({
    deviceSecretKey: secretKey,
    rootScopeId: session.profileId,
    driveId,
    root: publishRoot,
    dckGeneration: projected.keyEpoch,
    appKeySeq: options.appKeySeq ?? nextDriveRootSequence(session.profileId, driveId, appKeyPubkey),
    publishedAt: options.publishedAt ?? nextDriveRootPublishedAt(session.profileId, driveId, appKeyPubkey),
    publishedAtMs: options.publishedAtMs,
    authorizedAppKeyPubkeys: projected.activeAppKeyPubkeys,
    observed: profileDriveProjection.observations(
      session.profileId,
      driveId,
      new Set(projected.activeAppKeyPubkeys),
    ),
  });

  // Retain the just-signed contribution immediately. A forced logical rebuild
  // (for example while approving another device) must not depend on the relay
  // echo arriving before it can include the newest local write.
  const retained = profileDriveProjection.add(
    rawEvent,
    parseDriveRootEventForDevice(rawEvent, secretKey),
  );
  const event = new NDKEvent(ndk, rawEvent);
  await publishEventWithFallback(event);
  if (retained) {
    // Run after this publish resolves so TreeRootRegistry can mark its local
    // record clean before the resolver replaces it with the merged view.
    globalThis.setTimeout(() => {
      void import('../stores/treeRootResolver')
        .then(({ rebuildRetainedDriveRootProjection }) => {
          rebuildRetainedDriveRootProjection(`${session.profileId}/${driveId}`);
        })
        .catch((error) => {
          console.warn('[driveRoot] Could not rebuild the retained local Drive projection:', error);
        });
    }, 0);
  }
  return true;
}
