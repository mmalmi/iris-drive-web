import { activeShareScope } from './shareScope';
import { toHex, type CID } from '@hashtree/core';
import { getPublicKey } from 'nostr-tools';
import type { NostrIdentitySession } from './deviceLink';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr';
import { publishEvent } from '../lib/nostrPublish';
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

const rewrapTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * A shared folder's files are readable by the devices each writer's latest
 * version was wrapped for. When the members change, a device that has written
 * to the folder publishes its version again, so someone who joined later can
 * read what it wrote without waiting for its next edit.
 */
export function scheduleShareRootRewrap(shareId: string): void {
  const pending = rewrapTimers.get(shareId);
  if (pending) clearTimeout(pending);
  rewrapTimers.set(shareId, setTimeout(() => {
    rewrapTimers.delete(shareId);
    void rewrapShareRoot(shareId).catch((error) => {
      console.warn('[driveRoot] Could not publish a shared folder again for its new members:', error);
    });
  }, 500));
}

async function rewrapShareRoot(shareId: string): Promise<void> {
  const session = getCurrentNostrIdentitySession();
  if (!session || session.status !== 'active' || !activeShareScope(shareId)?.canWrite) return;
  if (!profileDriveProjection.contributionRoot(shareId, 'main', session.appKeyPubkey)) return;
  const { getTreeRootSync } = await import('../stores/treeRoot');
  const root = getTreeRootSync(shareId, 'main');
  if (root?.key) await publishNostrIdentityDriveRootIfAvailable('main', root, { rootScopeId: shareId });
}

export async function publishNostrIdentityDriveRootIfAvailable(
  driveId: string,
  rootCid: CID,
  options: {
    rootScopeId?: string;
    publishedAt?: number;
    publishedAtMs?: number;
    appKeySeq?: number;
    /** Wait until a relay has the root: only for handing a Drive to a device being approved. */
    awaitRelay?: boolean;
  } = {},
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

  const rootScopeId = options.rootScopeId ?? session.profileId;
  const share = rootScopeId !== session.profileId ? activeShareScope(rootScopeId) : null;
  if (rootScopeId !== session.profileId && (!share?.canWrite || driveId !== 'main')) return false;
  const projected = share ? { projection: null, activeAppKeyPubkeys: share.recipients, keyEpoch: share.epoch } : projectSession(session);
  const writers = share?.writers ?? projected.activeAppKeyPubkeys;
  if (projected.projection && !projected.projection.active_facets[appKeyPubkey]) {
    console.warn('[driveRoot] Skipping NostrIdentity Drive root publish because AppKey is not active in roster');
    return false;
  }

  const previousContribution = profileDriveProjection.contributionRoot(
    rootScopeId,
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

  if (share) {
    const current = activeShareScope(rootScopeId);
    if (!current?.canWrite || current.record.folder.access?.updated_at !== share.record.folder.access?.updated_at) {
      return false;
    }
  }
  const rawEvent = buildDriveRootEvent({
    deviceSecretKey: secretKey,
    rootScopeId,
    driveId,
    root: publishRoot,
    dckGeneration: projected.keyEpoch,
    appKeySeq: options.appKeySeq ?? nextDriveRootSequence(rootScopeId, driveId, appKeyPubkey),
    publishedAt: options.publishedAt ?? nextDriveRootPublishedAt(rootScopeId, driveId, appKeyPubkey),
    publishedAtMs: options.publishedAtMs,
    authorizedAppKeyPubkeys: projected.activeAppKeyPubkeys,
    observed: profileDriveProjection.observations(
      rootScopeId,
      driveId,
      new Set(writers),
    ),
  });

  // Retain the just-signed contribution immediately. A forced logical rebuild
  // (for example while approving another device) must not depend on the relay
  // echo arriving before it can include the newest local write.
  const retained = profileDriveProjection.add(
    rawEvent,
    parseDriveRootEventForDevice(rawEvent, secretKey),
  );
  // The signed root is already retained above and the worker keeps it in its
  // outbox, so saving does not wait for a relay to accept it.
  const publishing = publishEvent(rawEvent);
  if (options.awaitRelay) {
    await publishing;
  } else {
    void publishing.catch((error) => {
      console.warn('[driveRoot] Could not hand the Drive root to the publisher:', error);
    });
  }
  if (retained) {
    // Run after this publish resolves so TreeRootRegistry can mark its local
    // record clean before the resolver replaces it with the merged view.
    globalThis.setTimeout(() => {
      void import('../stores/treeRootResolver')
        .then(({ rebuildRetainedDriveRootProjection }) => {
          rebuildRetainedDriveRootProjection(`${rootScopeId}/${driveId}`);
        })
        .catch((error) => {
          console.warn('[driveRoot] Could not rebuild the retained local Drive projection:', error);
        });
    }, 0);
  }
  return true;
}
