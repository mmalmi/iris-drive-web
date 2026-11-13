import { get } from 'svelte/store';
import { verifyEvent, type Event } from 'nostr-tools';
import { nostr, nostrStore } from '../nostr';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { publishEvent } from '../lib/nostrPublish';
import { ownDisplayName } from './ownDisplayName';
import { KIND_DRIVE_ROOT } from './protocol';
import { recipientEvidenceForAppKey, SHARE_ACCESS_LABEL } from './shareAdmin';
import {
  buildShareJoinRequest,
  folderFromAccessEventForJoin,
  SHARE_ADDED_LABEL,
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

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** How long a folder someone shared is looked for before it is left until Drive opens again. */
const ADDED_WAIT_MS = 120_000;

/**
 * While Drive is open, notice folders that people share with this account
 * directly, and keep them like any other: the admin's signed access list,
 * once it includes this device, is the only thing trusted.
 */
export function watchSharesAddedToMe(): () => void {
  const waiting = new Map<string, () => void>();
  let subscription: { stop: () => void } | null = null;
  let watched = '';
  const consider = (event: Event) => {
    const context = visitorContext();
    if (!context) return;
    let notice: { v?: number; share_id?: string; owner_profile_id?: string; name?: unknown; role?: unknown };
    try {
      if (!verifyEvent(event)) return;
      notice = JSON.parse(event.content);
    } catch {
      return;
    }
    const shareId = notice.share_id ?? '';
    if (notice.v !== 1 || !UUID.test(shareId) || !UUID.test(notice.owner_profile_id ?? '') || waiting.has(shareId)) return;
    if (get(acceptedShares).some((record) => record.share_id === shareId && record.local_profile_id === context.session.profileId)) return;
    const link: ShareJoinLink = {
      v: 1,
      share_id: shareId,
      owner_profile_id: notice.owner_profile_id!,
      admin: event.pubkey,
      name: typeof notice.name === 'string' ? notice.name.slice(0, 200) : 'Shared folder',
      role: notice.role === 'reader' ? 'reader' : 'editor',
      key: '',
    };
    const stopWaiting = waitUntilJoined(link, () => done());
    const timer = setTimeout(() => done(), ADDED_WAIT_MS);
    function done() {
      clearTimeout(timer);
      stopWaiting();
      waiting.delete(shareId);
    }
    waiting.set(shareId, done);
  };
  const refresh = () => {
    const context = visitorContext();
    const key = context && nostrStore.getState().pubkey === context.session.appKeyPubkey ? context.session.appKeyPubkey : '';
    if (key === watched) return;
    watched = key;
    subscription?.stop();
    subscription = null;
    for (const stop of [...waiting.values()]) stop();
    if (!key) return;
    const sub = nostr.subscribe({ kinds: [KIND_DRIVE_ROOT], '#l': [SHARE_ADDED_LABEL], '#p': [key] }, { closeAfterHistory: false });
    sub.on('event', consider);
    subscription = sub;
  };
  const stopSession = nostrStore.subscribe(refresh);
  return () => {
    stopSession();
    subscription?.stop();
    for (const stop of [...waiting.values()]) stop();
  };
}
