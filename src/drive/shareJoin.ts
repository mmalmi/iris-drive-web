import type { Event } from 'nostr-tools';
import { nostr } from '../nostr';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { publishEvent } from '../lib/nostrPublish';
import { ownDisplayName } from './ownDisplayName';
import { KIND_DRIVE_ROOT } from './protocol';
import { recipientEvidenceForAppKey, SHARE_ACCESS_LABEL } from './shareAdmin';
import {
  buildShareJoinRequest,
  folderFromAccessEventForJoin,
  type ShareJoinLink,
} from './shareJoinLink';
import { acceptedShares, upsertAcceptedShare, type AcceptedShareRecord } from './shareLibrary';

/** Joining a shared folder from a link: ask, then wait for an admin's device to add this one. */

const ACCESS_CHECK_MS = 4000;

function visitorContext() {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  if (!session || session.status !== 'active' || !secretKey) return null;
  return { session, secretKey };
}

/** Send the request. Sending it again is harmless: it replaces the earlier one. */
export async function requestToJoin(link: ShareJoinLink): Promise<void> {
  const context = visitorContext();
  if (!context) throw new Error('Sign in to join this folder');
  const { session, secretKey } = context;
  const requestedAt = Math.floor(Date.now() / 1000);
  await publishEvent(buildShareJoinRequest(link, recipientEvidenceForAppKey({
    appKeySecretKey: secretKey,
    profileId: session.profileId,
    rosterOps: session.rosterOps ?? [],
    displayName: await ownDisplayName(session),
    acceptedAt: requestedAt,
  }), requestedAt));
}

/**
 * Watch for the admin's signed access list that includes this device, then
 * keep the folder like any other accepted share. Returns a function that stops
 * watching.
 */
export function waitUntilJoined(link: ShareJoinLink, onJoined: (record: AcceptedShareRecord) => void): () => void {
  let stopped = false;
  let subscription: { stop: () => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const filter = { kinds: [KIND_DRIVE_ROOT], '#d': [link.share_id], '#l': [SHARE_ACCESS_LABEL] };

  function stop() {
    stopped = true;
    subscription?.stop();
    if (timer) clearTimeout(timer);
  }
  const consider = (event: Event) => {
    const context = visitorContext();
    if (stopped || !context) return;
    const folder = folderFromAccessEventForJoin(link, event, context.session.appKeyPubkey);
    if (!folder) return;
    const record: AcceptedShareRecord = {
      share_id: folder.share_id,
      local_profile_id: context.session.profileId,
      accepted_at: Math.floor(Date.now() / 1000),
      invite_payload: '',
      folder,
      shortcuts: [],
    };
    acceptedShares.update((records) => upsertAcceptedShare(records, record));
    stop();
    onJoined(record);
  };
  // A relay that was slow to store the list is asked again until the list arrives.
  const check = () => {
    if (stopped) return;
    subscription?.stop();
    const sub = nostr.subscribe(filter, { closeAfterHistory: false });
    sub.on('event', consider);
    subscription = sub;
    timer = setTimeout(check, ACCESS_CHECK_MS);
  };
  check();
  return stop;
}

/** The folder, if this device has already joined it. */
export function joinedShare(link: ShareJoinLink, records: AcceptedShareRecord[]): AcceptedShareRecord | null {
  const context = visitorContext();
  if (!context) return null;
  return records.find((record) => record.share_id === link.share_id
    && record.local_profile_id === context.session.profileId) ?? null;
}
