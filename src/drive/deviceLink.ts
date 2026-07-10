import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  createDeviceApprovalBootstrap,
  encodeDeviceApprovalBootstrap,
  pubkeyToNpub,
  npubToPubkey,
  type DeviceApprovalBootstrap,
} from '@iris/identity';
import {
  createNostrIdentityDeviceLinkInvite,
  encodeNostrIdentityDeviceLinkInvite,
  parseNostrIdentityDeviceLinkInvite,
  isCompleteNostrIdentityDeviceLinkInviteInput,
  type NostrIdentityDeviceLinkInvite,
  type NostrIdentityDeviceLinkRequest,
} from 'nostr-social-graph';
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from './protocolTypes';

export const DEVICE_LINK_INVITE_PREFIX = 'https://drive.iris.to/invite/';
export const DEVICE_LINK_INVITE_VERSION = 1;

export type DeviceLinkInvite = NostrIdentityDeviceLinkInvite;
export type DeviceLinkRequest = NostrIdentityDeviceLinkRequest;
export type DriveDeviceApprovalBootstrap = DeviceApprovalBootstrap;

export interface PendingDriveDeviceApproval {
  bootstrap: DriveDeviceApprovalBootstrap;
  requestSecretKeyNsec: string;
}

export type NostrIdentitySessionStatus = 'active' | 'pending_device_link';

export interface NostrIdentitySession {
  profileId: NostrIdentityId;
  appKeyPubkey: string;
  appKeyNpub: string;
  appKeyNsec: string;
  status: NostrIdentitySessionStatus;
  rosterOps: SignedNostrIdentityRosterOp[];
  createdAt: number;
  label?: string;
  pendingDeviceLink?: DeviceLinkRequest;
  pendingDeviceApproval?: PendingDriveDeviceApproval;
}

export interface StoredNostrIdentitySession {
  schema: 1;
  profileId: NostrIdentityId;
  appKeyNsec: string;
  status: NostrIdentitySessionStatus;
  rosterOps: SignedNostrIdentityRosterOp[];
  createdAt: number;
  label?: string;
  pendingDeviceLink?: DeviceLinkRequest;
  pendingDeviceApproval?: PendingDriveDeviceApproval;
}

export interface DriveDeviceApprovalDraft {
  appKeySecretKey: Uint8Array;
  requestSecretKey: Uint8Array;
  bootstrap: DriveDeviceApprovalBootstrap;
  url: string;
}

export function encodeDeviceLinkInvite(invite: DeviceLinkInvite): string {
  return encodeNostrIdentityDeviceLinkInvite(invite, { prefix: DEVICE_LINK_INVITE_PREFIX });
}

export function parseDeviceLinkInvite(input: string): DeviceLinkInvite | null {
  return parseNostrIdentityDeviceLinkInvite(input, {
    prefixes: [DEVICE_LINK_INVITE_PREFIX],
  });
}

export function isCompleteDeviceLinkInviteInput(input: string): boolean {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value || /\s/.test(value)) return false;
  if (payloadFromShareInviteUrl(value) !== null) return false;
  return isCompleteNostrIdentityDeviceLinkInviteInput(value, {
    prefixes: [DEVICE_LINK_INVITE_PREFIX],
  });
}

export function createDeviceLinkInvite(options: {
  profileId: NostrIdentityId;
  adminAppKeyPubkey: string;
  inviteSecretKey?: Uint8Array;
}): DeviceLinkInvite & { inviteSecretKey: Uint8Array } {
  return createNostrIdentityDeviceLinkInvite(options);
}

export function createPendingDeviceLinkSession(options: {
  invite: DeviceLinkInvite;
  appKeySecretKey?: Uint8Array;
  requestedAt?: number;
  label?: string;
}): NostrIdentitySession {
  const appKeySecretKey = options.appKeySecretKey ?? generateSecretKey();
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const requestedAt = options.requestedAt ?? Math.floor(Date.now() / 1000);
  const pendingDeviceLink: DeviceLinkRequest = {
    profileId: options.invite.profileId,
    adminAppKeyPubkey: options.invite.adminAppKeyPubkey,
    invitePubkey: options.invite.invitePubkey,
    deviceAppKeyPubkey: appKeyPubkey,
    requestedAt,
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  };

  return {
    profileId: options.invite.profileId,
    appKeyPubkey,
    appKeyNpub: nip19.npubEncode(appKeyPubkey),
    appKeyNsec: nip19.nsecEncode(appKeySecretKey),
    status: 'pending_device_link',
    rosterOps: [],
    createdAt: requestedAt,
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
    pendingDeviceLink,
  };
}

export function createDriveDeviceApprovalDraft(options: {
  appKeySecretKey?: Uint8Array;
  requestSecretKey?: Uint8Array;
  requestSecret?: string;
  label?: string;
} = {}): DriveDeviceApprovalDraft {
  const appKeySecretKey = options.appKeySecretKey ?? generateSecretKey();
  const { bootstrap, requestSecretKey } = createDeviceApprovalBootstrap({
    deviceAppKeySecretKey: appKeySecretKey,
    ...(options.requestSecretKey ? { requestSecretKey: options.requestSecretKey } : {}),
    ...(options.requestSecret ? { requestSecret: options.requestSecret } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
  return {
    appKeySecretKey,
    requestSecretKey,
    bootstrap,
    url: encodeDeviceApprovalBootstrap(bootstrap),
  };
}

export function pendingDriveDeviceApprovalFromDraft(
  draft: Pick<DriveDeviceApprovalDraft, 'bootstrap' | 'requestSecretKey'>,
): PendingDriveDeviceApproval {
  return {
    bootstrap: { ...draft.bootstrap },
    requestSecretKeyNsec: nip19.nsecEncode(draft.requestSecretKey),
  };
}

export function driveDeviceApprovalRequestSecretKey(pending: PendingDriveDeviceApproval): Uint8Array {
  const decoded = nip19.decode(pending.requestSecretKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Stored device approval request secret is not an nsec');
  }
  const secretKey = decoded.data as Uint8Array;
  if (getPublicKey(secretKey) !== npubToPubkey(pending.bootstrap.requestNpub)) {
    throw new Error('Stored device approval request secret does not match the request pubkey');
  }
  return secretKey;
}

export { pubkeyToNpub, npubToPubkey };

function payloadFromShareInviteUrl(input: string): string | null {
  const lower = input.toLowerCase();
  const prefix = [
    'iris-drive://share-invite/',
    'iris-drive:/share-invite/',
    'https://drive.iris.to/share-invite/',
  ].find((candidate) => lower.startsWith(candidate));
  if (!prefix) return null;
  return input.slice(prefix.length).split(/[?#]/, 1)[0].trim();
}
