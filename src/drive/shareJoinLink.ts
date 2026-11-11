import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import type {
  NostrIdentityId,
  ShareAccessSnapshot,
  ShareRecipient,
  ShareRecipientProfileEvidence,
  ShareRole,
  SharedFolder,
} from './protocolTypes';
import { KIND_DRIVE_ROOT } from './protocolTypes';
import { base64UrlEncode } from './protocolJson';
import {
  parseNostrIdentityFacetAcceptanceEvent,
  parseNostrIdentityRosterOpEvent,
} from './protocolProfileEvents';
import { projectSharedFolderKeys, snapshotMembers } from './protocolShareSnapshot';
import { validateShareAccessUpdate } from './protocolShareSnapshotValidation';
import {
  resolveShareRecipientFromEvidence,
  shareRecipientsForResolvedRecipient,
} from './protocolShareRecipients';

/**
 * A join link lets whoever opens it ask to be added to a shared folder.
 *
 * Access to a folder is given to a person's device keys, so a link cannot
 * simply carry access. Instead the link carries a key of its own. The
 * visitor's browser signs a request with it, which proves it holds the link,
 * and an admin's Drive adds the visitor's device the next time it is open.
 */

export const SHARE_JOIN_LABEL = 'iris-drive/share-join';
export const SHARE_JOIN_ROUTE = '/share-join/';

export interface ShareJoinLink {
  v: 1;
  share_id: NostrIdentityId;
  owner_profile_id: NostrIdentityId;
  /** The admin device whose signed access list the visitor trusts. */
  admin: string;
  name: string;
  role: Exclude<ShareRole, 'admin'>;
  /** The link's own secret key, hex. */
  key: string;
  /** A document to open inside the folder. */
  doc?: string;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{64}$/;

export function shareJoinLinkPubkey(link: Pick<ShareJoinLink, 'key'>): string {
  return getPublicKey(hexToBytes(link.key));
}

export function encodeShareJoinLink(link: ShareJoinLink, origin: string): string {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(link)));
  return `${origin.replace(/\/+$/, '')}/#${SHARE_JOIN_ROUTE}${payload}`;
}

export function parseShareJoinLink(input: string): ShareJoinLink {
  const payload = input.includes(SHARE_JOIN_ROUTE) ? input.split(SHARE_JOIN_ROUTE)[1]! : input.trim();
  let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  const link = JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  )) as ShareJoinLink;
  if (link.v !== 1 || !UUID.test(link.share_id) || !UUID.test(link.owner_profile_id)
    || !HEX32.test(link.admin) || !HEX32.test(link.key) || typeof link.name !== 'string'
    || (link.role !== 'editor' && link.role !== 'reader')
    || (link.doc !== undefined && (typeof link.doc !== 'string' || link.doc.includes('/')))) {
    throw new Error('This link is not valid');
  }
  return link;
}

function joinRequestDTag(shareId: string, requesterPubkey: string): string {
  return `iris-drive/share-join/${shareId}/${requesterPubkey}`;
}

/** One request per requesting device; sending it again replaces the earlier one. */
export function buildShareJoinRequest(
  link: ShareJoinLink,
  evidence: ShareRecipientProfileEvidence,
  requestedAt: number,
): Event {
  const requester = evidence.representative_pubkey ?? '';
  if (!HEX32.test(requester)) throw new Error('Missing device key');
  return finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    created_at: requestedAt,
    content: JSON.stringify(evidence),
    tags: [
      ['d', joinRequestDTag(link.share_id, requester)],
      ['l', SHARE_JOIN_LABEL],
      ['i', link.share_id],
    ],
  }, hexToBytes(link.key));
}

export function shareJoinRequestFilter(linkPubkeys: string[]) {
  return { kinds: [KIND_DRIVE_ROOT], authors: linkPubkeys, '#l': [SHARE_JOIN_LABEL] };
}

/**
 * Check a request against the link it claims to come from and return the
 * devices to add. Every signature inside the request is checked again here:
 * nothing in it is taken on trust.
 */
export function shareRecipientsFromJoinRequest(
  link: ShareJoinLink,
  event: Event,
): { recipients: ShareRecipient[]; profileId: NostrIdentityId; requester: string } {
  if (event.kind !== KIND_DRIVE_ROOT || event.pubkey !== shareJoinLinkPubkey(link) || !verifyEvent(event)
    || !event.tags.some(([name, value]) => name === 'l' && value === SHARE_JOIN_LABEL)) {
    throw new Error('Request was not made with this link');
  }
  const claimed = JSON.parse(event.content) as ShareRecipientProfileEvidence;
  const requester = (claimed.representative_pubkey ?? '').toLowerCase();
  const dTag = event.tags.find(([name]) => name === 'd')?.[1];
  if (!HEX32.test(requester) || dTag !== joinRequestDTag(link.share_id, requester)) {
    throw new Error('Request does not match this folder');
  }
  const evidence: ShareRecipientProfileEvidence = {
    profile_id: claimed.profile_id,
    representative_pubkey: requester,
    display_name: typeof claimed.display_name === 'string' ? claimed.display_name.slice(0, 80) : undefined,
    roster_ops: (claimed.roster_ops ?? []).map((op) => parseNostrIdentityRosterOpEvent(JSON.parse(op.event_json))),
    acceptances: (claimed.acceptances ?? [])
      .map((acceptance) => parseNostrIdentityFacetAcceptanceEvent(JSON.parse(acceptance.event_json))),
  };
  const resolved = resolveShareRecipientFromEvidence(evidence);
  if (!resolved.app_pubkeys.includes(requester)) throw new Error('Requesting device is not part of the profile');
  return {
    recipients: shareRecipientsForResolvedRecipient(resolved, link.role),
    profileId: resolved.profile_id,
    requester,
  };
}

/** Whether a request still needs an admin to act on it. */
export function joinRequestNeedsApproval(folder: SharedFolder, profileId: NostrIdentityId, requester: string): boolean {
  if (!folder.access) return false;
  if (snapshotMembers(folder.access)[profileId]?.status === 'revoked') return false;
  return !projectSharedFolderKeys(folder).active_facets[requester];
}

/**
 * The visitor's side: turn the admin's signed access list into a folder this
 * device can open, once the list includes this device. Only a list signed by
 * the admin named in the link is accepted as the starting point.
 */
export function folderFromAccessEventForJoin(
  link: ShareJoinLink,
  event: Event,
  appKeyPubkey: string,
): SharedFolder | null {
  if (event.pubkey !== link.admin) return null;
  let access: ShareAccessSnapshot;
  try {
    access = JSON.parse(event.content) as ShareAccessSnapshot;
  } catch {
    return null;
  }
  const folder: SharedFolder = {
    share_id: link.share_id,
    owner_profile_id: link.owner_profile_id,
    source_path: '',
    display_name: link.name,
    local_role: link.role,
    access,
    pending_invites: {},
    app_key_roots: {},
  };
  try {
    folder.access = validateShareAccessUpdate(folder, event);
  } catch {
    return null;
  }
  const device = folder.access.devices?.[appKeyPubkey];
  if (!device?.profile_id || !projectSharedFolderKeys(folder).active_facets[appKeyPubkey]) return null;
  const member = snapshotMembers(folder.access)[device.profile_id];
  if (!member || member.status !== 'active') return null;
  return { ...folder, local_role: member.role };
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}
