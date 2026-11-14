import { activeShareScope } from './shareScope';
import { toHex, type CID } from '@hashtree/core';
import { getPublicKey, type Event } from 'nostr-tools';
import type { NostrIdentitySession } from './deviceLink';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr';
import { publishEvent } from '../lib/nostrPublish';
import { profileDriveProjection } from './profileDriveProjection';
import { heldRecoveryKeys, recoveryPhraseRecipients, rootWrapRecipients } from './recoveryRootKeys';
import {
  buildDriveRootEvent,
  parseDriveRootEventForDevice,
  projectNostrIdentityRoster,
  type NostrIdentityRosterProjection,
} from './protocol';

type SessionProjection = {
  projection: NostrIdentityRosterProjection | null;
  /** The account's recovery phrase keys: own roots are wrapped for them too. */
  recoveryPubkeys: string[];
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
    recoveryPubkeys: recoveryPhraseRecipients(projection),
    activeAppKeyPubkeys: Array.from(activeAppKeyPubkeys).sort(),
    keyEpoch,
  };
}

// Counters live in storage so they survive a reload. Where storage is blocked
// they are kept for the session, which still keeps versions in order.
const sessionCounters = new Map<string, number>();

function readCounter(storageKey: string): number {
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(storageKey) ?? '0');
  } catch {
    // Storage is unavailable.
  }
  const value = Math.max(Number.isFinite(stored) ? stored : 0, sessionCounters.get(storageKey) ?? 0);
  return value > 0 ? value : 0;
}

function writeCounter(storageKey: string, value: number): void {
  sessionCounters.set(storageKey, value);
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // Storage is unavailable.
  }
}

function nextDriveRootSequence(profileId: string, driveId: string, appKeyPubkey: string): number {
  const storageKey = `iris:drive-root-seq:${profileId}:${driveId}:${appKeyPubkey}`;
  const next = readCounter(storageKey) + 1;
  writeCounter(storageKey, next);
  return next;
}

/**
 * The time a new version is published with. A relay keeps one version per
 * device and decides between two by this time alone, so every version must
 * carry a later second than the one before: two that share a second leave
 * either standing, and other devices may then be served the older content.
 * `wanted` is the time the caller would use (the moment of the save).
 */
function nextDriveRootPublishedAt(profileId: string, driveId: string, appKeyPubkey: string, wanted?: number): number {
  const storageKey = `iris:drive-root-created-at:${profileId}:${driveId}:${appKeyPubkey}`;
  const next = Math.max(wanted ?? Math.floor(Date.now() / 1000), readCounter(storageKey) + 1);
  writeCounter(storageKey, next);
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
  scheduleRootRewrap(shareId);
}

/**
 * The same for the account's own Drive, when it gains a device this one did
 * not let in itself, such as one signed in with the recovery phrase.
 */
export function scheduleDriveRootRewrap(profileId: string): void {
  scheduleRootRewrap(profileId);
}

/**
 * This device's latest root of its own My Drive is published again when its
 * key is not wrapped for every recovery phrase key of the account, as for a
 * root published before the phrase was added or before roots were wrapped for
 * recovery keys at all.
 */
export function wrapOwnRootForRecoveryKeys(rootScopeId: string, event: Pick<Event, 'pubkey' | 'content'>): void {
  const session = getCurrentNostrIdentitySession();
  if (!session || session.status !== 'active' || rootScopeId !== session.profileId || event.pubkey !== session.appKeyPubkey) return;
  const wrapped = rootWrapRecipients(event);
  if (projectSession(session).recoveryPubkeys.every((pubkey) => wrapped.has(pubkey))) return;
  scheduleDriveRootRewrap(rootScopeId);
}

/**
 * After a root came in: this device's own one is published again when it
 * lacks a recovery wrap, and one opened only through a held recovery key makes
 * this device keep the Drive as its own.
 */
export function recoveryKeysAfterRoot(rootScopeId: string, event: Pick<Event, 'pubkey' | 'content'>, deviceSecretKey: Uint8Array): void {
  wrapOwnRootForRecoveryKeys(rootScopeId, event);
  if (heldRecoveryKeys().length > 0 && !rootWrapRecipients(event).has(getPublicKey(deviceSecretKey))) adoptRecoveredDrive(rootScopeId);
}

const ADOPT_AFTER_MS = 1500;
let adoptTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A device signed in with the recovery phrase opened the other devices' roots
 * with the phrase's key, which it holds only until the page closes. Once they
 * have come in, it publishes the Drive it now sees as its own root, wrapped
 * for itself, so it keeps the files without the phrase.
 */
export function adoptRecoveredDrive(profileId: string): void {
  clearTimeout(adoptTimer);
  adoptTimer = setTimeout(() => {
    void (async () => {
      const session = getCurrentNostrIdentitySession();
      if (!session || session.status !== 'active' || session.profileId !== profileId) return;
      const { getTreeRootSync } = await import('../stores/treeRoot');
      const root = getTreeRootSync(profileId, 'main');
      if (root?.key) await publishNostrIdentityDriveRootIfAvailable('main', root, { rootScopeId: profileId });
    })().catch((error) => console.warn('[driveRoot] Could not keep the recovered Drive:', error));
  }, ADOPT_AFTER_MS);
}

function scheduleRootRewrap(rootScopeId: string): void {
  const pending = rewrapTimers.get(rootScopeId);
  if (pending) clearTimeout(pending);
  rewrapTimers.set(rootScopeId, setTimeout(() => {
    rewrapTimers.delete(rootScopeId);
    void rewrapRoot(rootScopeId).catch((error) => {
      console.warn('[driveRoot] Could not publish a Drive again for its new devices:', error);
    });
  }, 500));
}

async function rewrapRoot(rootScopeId: string): Promise<void> {
  const session = getCurrentNostrIdentitySession();
  if (!session || session.status !== 'active') return;
  if (rootScopeId !== session.profileId && !activeShareScope(rootScopeId)?.canWrite) return;
  if (!profileDriveProjection.contributionRoot(rootScopeId, 'main', session.appKeyPubkey)) return;
  const { getTreeRootSync } = await import('../stores/treeRoot');
  const root = getTreeRootSync(rootScopeId, 'main');
  if (root?.key) await publishNostrIdentityDriveRootIfAvailable('main', root, { rootScopeId });
}

interface DriveRootPublishOptions {
  rootScopeId?: string;
  publishedAt?: number;
  publishedAtMs?: number;
  appKeySeq?: number;
  /** Wait until the root is stored for sending (no relay is waited for): for handing a Drive to a device being approved. */
  awaitRelay?: boolean;
}

const publishQueues = new Map<string, Promise<unknown>>();

// Handing an event to the worker takes milliseconds. Past this the version is
// tried again later instead of holding up the ones queued behind it.
const HAND_OVER_TIMEOUT_MS = 15_000;

/** Resolves true once the worker holds the event for sending. */
function heldForSending(publishing: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HAND_OVER_TIMEOUT_MS);
    publishing.then(() => true, (error) => {
      console.warn('[driveRoot] Could not hand the Drive root to the publisher:', error);
      return false;
    }).then((held) => {
      clearTimeout(timer);
      resolve(held);
    });
  });
}

/**
 * Publishes a version of a Drive. Versions of one Drive go out one at a time,
 * in the order they were asked for: each is given its time only once its
 * blocks are uploaded, so two running side by side could finish in the wrong
 * order and leave the older content with the later time, which is the one
 * relays and other devices keep.
 */
export function publishNostrIdentityDriveRootIfAvailable(
  driveId: string,
  rootCid: CID,
  options: DriveRootPublishOptions = {},
): Promise<boolean> {
  const scope = options.rootScopeId ?? getCurrentNostrIdentitySession()?.profileId ?? '';
  const queueKey = `${scope}/${driveId}`;
  const publishing = (publishQueues.get(queueKey) ?? Promise.resolve())
    .catch(() => {})
    .then(() => publishDriveRootNow(driveId, rootCid, options));
  publishQueues.set(queueKey, publishing);
  void publishing.catch(() => {}).then(() => {
    if (publishQueues.get(queueKey) === publishing) publishQueues.delete(queueKey);
  });
  return publishing;
}

async function publishDriveRootNow(
  driveId: string,
  rootCid: CID,
  options: DriveRootPublishOptions,
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
  const projected = share ? { projection: null, activeAppKeyPubkeys: share.recipients, keyEpoch: share.epoch, recoveryPubkeys: [] } : projectSession(session);
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
    publishedAt: nextDriveRootPublishedAt(rootScopeId, driveId, appKeyPubkey, options.publishedAt),
    publishedAtMs: options.publishedAtMs,
    authorizedAppKeyPubkeys: [...projected.activeAppKeyPubkeys, ...projected.recoveryPubkeys],
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
  // The worker keeps a root it was handed and sends it when it can, so no
  // relay is waited for. The hand-over itself is: this version counts as
  // published only once the worker holds it. Until then it stays marked
  // unpublished, and a page that is reloaded or closed in between publishes it
  // again when it next opens. Counting it published too early brought the
  // Drive back from relays without the last edits.
  const publishing = publishEvent(rawEvent);
  if (options.awaitRelay) {
    await publishing;
  } else if (!await heldForSending(publishing)) {
    return false;
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
