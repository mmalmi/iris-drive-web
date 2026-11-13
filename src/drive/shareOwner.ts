import { get } from 'svelte/store';
import { LinkType, type CID } from '@hashtree/core';
import { finalizeEvent, type Event } from 'nostr-tools';
import { nostr, nostrStore } from '../nostr';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { saveOwnTreeRoot } from '../nostr/trees';
import { publishEvent } from '../lib/nostrPublish';
import { isDocumentFolderName } from '../lib/documentNames';
import { getTree } from '../store';
import { getTreeRootSync, waitForTreeRoot } from '../stores/treeRoot';
import { ownDisplayName } from './ownDisplayName';
import {
  KIND_DRIVE_ROOT,
  projectNostrIdentityRoster,
  shareRecipientsForResolvedRecipient,
  type NostrIdentityId,
  type ShareRole,
  type SharedFolder,
} from './protocol';
import { mutateProfileDriveRoot } from './profileDriveMutation';
import {
  addShareRecipients,
  createSharedFolder,
  revokeShareMember,
  setShareMemberRole,
  signShareAccessSnapshot,
} from './shareAdmin';
import {
  encodeShareJoinLink,
  joinRequestNeedsApproval,
  SHARE_ADDED_LABEL,
  shareJoinLinkPubkey,
  shareJoinRequestFilter,
  shareRecipientsFromJoinRequest,
  type ShareJoinLink,
} from './shareJoinLink';
import { acceptedShares, upsertAcceptedShare, type AcceptedShareRecord } from './shareLibrary';

/**
 * Sharing as the owner, in the browser: turn a folder or document of this
 * Drive into a shared folder, hand out join links, and add the people who
 * open them.
 */

const DRIVE_ID = 'main';

function ownerContext() {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  if (!session || session.status !== 'active' || !secretKey) throw new Error('Sign in to share');
  return { session, secretKey };
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function ownRecords(profileId: NostrIdentityId): AcceptedShareRecord[] {
  return get(acceptedShares).filter((record) => record.local_profile_id === profileId);
}

function ownRecord(shareId: NostrIdentityId): AcceptedShareRecord {
  const { session } = ownerContext();
  const record = ownRecords(session.profileId).find((item) => item.share_id === shareId);
  if (!record) throw new Error('Shared folder not found');
  return record;
}

function storeRecord(record: AcceptedShareRecord): AcceptedShareRecord {
  acceptedShares.update((records) => upsertAcceptedShare(records, record));
  return ownRecord(record.share_id);
}

/** Share a folder or document of this Drive. Its current contents become the shared folder's first version. */
export async function shareFromDrive(path: string[], displayName: string): Promise<AcceptedShareRecord> {
  const { session, secretKey } = ownerContext();
  const sourcePath = path.join('/');
  if (!sourcePath) throw new Error('Choose a folder to share');
  const overlapping = ownRecords(session.profileId).some((record) => {
    const source = record.folder.source_path;
    return record.folder.owner_profile_id === session.profileId && source
      && (source === sourcePath || source.startsWith(`${sourcePath}/`) || sourcePath.startsWith(`${source}/`));
  });
  if (overlapping) throw new Error('This is already part of a shared folder');

  const tree = getTree();
  const driveRoot = getTreeRootSync(session.profileId, DRIVE_ID)
    ?? await waitForTreeRoot(session.profileId, DRIVE_ID, 15_000);
  const entry = driveRoot ? await tree.resolvePath(driveRoot, path) : null;
  if (!entry || entry.type !== LinkType.Dir) throw new Error('Only folders and documents can be shared');

  const name = path[path.length - 1]!;
  let shareRoot: CID = entry.cid;
  if (isDocumentFolderName(name)) {
    const { cid: empty } = await tree.putDirectory([]);
    shareRoot = await mutateProfileDriveRoot(tree, empty, {
      type: 'set-entry',
      path: name,
      entry: { cid: entry.cid, size: 0, type: LinkType.Dir },
    }, { recordTombstones: false });
  }

  const roster = projectNostrIdentityRoster(session.profileId, session.rosterOps ?? []);
  const devices = Object.values(roster.active_facets)
    .filter((facet) => facet.purposes?.includes('app_key') && facet.capabilities?.can_receive_secret_wraps)
    .map((facet) => ({ pubkey: facet.pubkey, label: facet.label }));
  const folder = createSharedFolder({
    signerSecretKey: secretKey,
    ownerProfileId: session.profileId,
    ownerDevices: devices,
    sourcePath,
    displayName,
    ownerName: await ownDisplayName(session),
    createdAt: now(),
  });
  const record = storeRecord({
    share_id: folder.share_id,
    local_profile_id: session.profileId,
    accepted_at: now(),
    invite_payload: '',
    folder,
    shortcuts: [],
    join_links: [],
  });
  if (!saveOwnTreeRoot(folder.share_id, DRIVE_ID, shareRoot)) throw new Error('Could not save the shared folder');
  await publishEvent(signShareAccessSnapshot(secretKey, folder));
  return record;
}

/**
 * The link for a role, made on first use; the same link is returned every time
 * after. `doc` opens the link at one document of the folder.
 */
export function joinLinkUrl(
  shareId: NostrIdentityId,
  role: ShareJoinLink['role'],
  options: { doc?: string; origin?: string } = {},
): string {
  const { session } = ownerContext();
  const record = ownRecord(shareId);
  let link = record.join_links?.find((item) => item.role === role);
  if (!link) {
    link = {
      v: 1,
      share_id: shareId,
      owner_profile_id: record.folder.owner_profile_id,
      admin: session.appKeyPubkey,
      name: record.folder.display_name,
      role,
      key: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
    storeRecord({ ...record, join_links: [...(record.join_links ?? []), link] });
  }
  const source = record.folder.source_path.split('/').at(-1);
  const doc = options.doc ?? (isDocumentFolderName(source) ? source : undefined);
  return encodeShareJoinLink({ ...link, ...(doc ? { doc } : {}) }, options.origin ?? window.location.origin);
}

/** Stop a link from adding anyone else. People who already joined keep their access. */
export function disableJoinLinks(shareId: NostrIdentityId): void {
  storeRecord({ ...ownRecord(shareId), join_links: [] });
}

async function applyAccessChange(shareId: NostrIdentityId, folder: SharedFolder): Promise<void> {
  const { secretKey } = ownerContext();
  const record = ownRecord(shareId);
  if (folder === record.folder) return;
  storeRecord({ ...record, folder });
  // Publishing resolves once the event is stored for sending; the publisher
  // keeps trying on its own and no relay's answer is waited for.
  await publishEvent(signShareAccessSnapshot(secretKey, folder));
  await republishShareRoot(shareId);
}

/**
 * A folder's files are readable by the devices its latest version was wrapped
 * for. After membership changes, publish this device's version again so it is
 * wrapped for exactly the current members, and holds everything written so far.
 * The version is rebuilt from the roots this device holds, since a change of
 * members makes it forget the one it had; no relay is waited for, because
 * someone just let in is looking at a spinner until this goes out.
 */
async function republishShareRoot(shareId: NostrIdentityId): Promise<boolean> {
  const before = getTreeRootSync(shareId, DRIVE_ID);
  try {
    const { resolveDriveRootProjectionNow } = await import('../stores/treeRootResolver');
    await resolveDriveRootProjectionNow(`${shareId}/${DRIVE_ID}`);
  } catch {
    // Nothing to rebuild from: publish what this device had.
  }
  const root = getTreeRootSync(shareId, DRIVE_ID) ?? before;
  if (!root?.key) return false;
  const { publishNostrIdentityDriveRootIfAvailable } = await import('./profileDriveRootPublish');
  return publishNostrIdentityDriveRootIfAvailable(DRIVE_ID, root, { rootScopeId: shareId });
}

export async function changeShareMemberRole(shareId: NostrIdentityId, profileId: NostrIdentityId, role: ShareRole): Promise<void> {
  const { secretKey } = ownerContext();
  await applyAccessChange(shareId, setShareMemberRole(ownRecord(shareId).folder, secretKey, profileId, role, now()));
}

export async function removeShareMember(shareId: NostrIdentityId, profileId: NostrIdentityId): Promise<void> {
  const { secretKey } = ownerContext();
  await applyAccessChange(shareId, revokeShareMember(ownRecord(shareId).folder, secretKey, profileId, now()));
}

export interface ShareAddedNotice {
  v: 1;
  share_id: NostrIdentityId;
  owner_profile_id: NostrIdentityId;
  name: string;
  role: Exclude<ShareRole, 'admin'>;
}

/** Changes to who has access, applied one at a time. */
let accessChanges: Promise<void> = Promise.resolve();

/** Thrown when relays know no devices for a person, so they cannot be added directly. */
export class NoDevicesFoundError extends Error {
  constructor() {
    super('Could not find their devices. Send them the invite link instead.');
  }
}

/**
 * Add a person by their key. Their devices are looked up on relays first,
 * the one wait in sharing; then they are added like anyone who joined by
 * link, and their devices are told so they find it in Shared with me.
 */
export async function addPersonToShare(
  shareId: NostrIdentityId,
  pubkey: string,
  role: Exclude<ShareRole, 'admin'>,
  displayName?: string,
): Promise<void> {
  const { secretKey } = ownerContext();
  ownRecord(shareId);
  const { findShareRecipient } = await import('./sharePersonLookup');
  const resolved = await findShareRecipient(pubkey);
  if (!resolved) throw new NoDevicesFoundError();
  const recipient = { ...resolved, display_name: displayName?.trim() || resolved.display_name };
  // One change at a time: each builds on the access list the one before produced.
  const change = accessChanges.then(() => applyAccessChange(
    shareId,
    addShareRecipients(ownRecord(shareId).folder, secretKey, shareRecipientsForResolvedRecipient(recipient, role), now()),
  ));
  accessChanges = change.catch(() => undefined);
  await change;
  const { folder } = ownRecord(shareId);
  const notice: ShareAddedNotice = {
    v: 1,
    share_id: shareId,
    owner_profile_id: folder.owner_profile_id,
    name: folder.display_name,
    role,
  };
  await publishEvent(finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    created_at: now(),
    content: JSON.stringify(notice),
    tags: [
      ['d', `${SHARE_ADDED_LABEL}/${shareId}/${resolved.profile_id}`],
      ['l', SHARE_ADDED_LABEL],
      ['i', shareId],
      ...resolved.app_pubkeys.map((appPubkey) => ['p', appPubkey]),
    ],
  }, secretKey));
}

/** Add the person behind a join request, if the request is valid and still needed. */
export function approveJoinRequest(event: Event): Promise<void> {
  // One at a time: each approval builds on the access list the previous one produced.
  accessChanges = accessChanges.then(async () => {
    const { session, secretKey } = ownerContext();
    for (const record of ownRecords(session.profileId)) {
      const link = record.join_links?.find((item) => shareJoinLinkPubkey(item) === event.pubkey);
      if (!link) continue;
      const { recipients, profileId, requester } = shareRecipientsFromJoinRequest(link, event);
      if (!joinRequestNeedsApproval(record.folder, profileId, requester)) return;
      await applyAccessChange(record.share_id, addShareRecipients(record.folder, secretKey, recipients, now()));
      return;
    }
  }).catch((error) => {
    console.warn('[share] Could not add a person who asked to join:', error);
  });
  return accessChanges;
}

/**
 * While Drive is open, listen for people opening this device's join links.
 * Requests made while it was closed are still on the relays and arrive first.
 */
export function watchJoinRequests(): () => void {
  let subscription: { stop: () => void } | null = null;
  let watched = '';
  const refresh = () => {
    const session = getCurrentNostrIdentitySession();
    const pubkeys = session?.status === 'active' && nostrStore.getState().pubkey === session.appKeyPubkey
      ? ownRecords(session.profileId).flatMap((record) => (record.join_links ?? []).map(shareJoinLinkPubkey)).sort()
      : [];
    const key = pubkeys.join(',');
    if (key === watched) return;
    watched = key;
    subscription?.stop();
    subscription = null;
    if (pubkeys.length === 0) return;
    const sub = nostr.subscribe(shareJoinRequestFilter(pubkeys), { closeAfterHistory: false });
    sub.on('event', (event: Event) => { void approveJoinRequest(event); });
    subscription = sub;
  };
  const stopShares = acceptedShares.subscribe(refresh);
  const stopSession = nostrStore.subscribe(refresh);
  return () => {
    stopShares();
    stopSession();
    subscription?.stop();
  };
}
