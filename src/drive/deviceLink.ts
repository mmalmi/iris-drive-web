import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  createNostrIdentityDeviceApprovalRequest,
  createDeviceApprovalBootstrap,
  encodeDeviceApprovalBootstrap,
  parseDeviceApprovalBootstrap,
  createNostrIdentityDeviceLinkInvite,
  encodeNostrIdentityDeviceLinkInvite,
  parseNostrIdentityDeviceLinkInvite,
  isCompleteNostrIdentityDeviceLinkInviteInput,
  nostrIdentityDeviceApprovalRelayResource,
  pubkeyToNpub,
  npubToPubkey,
  type LocalNostrIdentityDeviceApprovalRequest,
  type DeviceApprovalBootstrap,
  type NostrIdentityDeviceApprovalRequest,
  type NostrIdentityDeviceApprovalRequestedResource,
  type NostrIdentityDeviceLinkInvite,
  type NostrIdentityDeviceLinkRequest,
} from '@iris/identity';
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from './protocolTypes';

export const DEVICE_LINK_INVITE_PREFIX = 'https://drive.iris.to/invite/';
export const DEVICE_APPROVAL_REQUEST_PREFIX = 'https://drive.iris.to/approve-device/';
export const DEVICE_LINK_INVITE_VERSION = 1;
export const DEVICE_APPROVAL_REQUEST_TYPE = 'device_link';
export const DRIVE_DEVICE_APPROVAL_RELAY_URL = 'wss://temp.iris.to';

export const DRIVE_DEVICE_APPROVAL_RESOURCES: readonly NostrIdentityDeviceApprovalRequestedResource[] = [
  {
    type: 'iris_drive',
    id: 'drive.iris.to',
    scopes: [
      'app_key',
      'write_roots',
      'receive_secret_wraps',
      'decrypt_secret_epochs',
    ],
  },
  nostrIdentityDeviceApprovalRelayResource(DRIVE_DEVICE_APPROVAL_RELAY_URL),
];

export type DeviceLinkInvite = NostrIdentityDeviceLinkInvite;
export type DeviceLinkRequest = NostrIdentityDeviceLinkRequest;
export type FullDriveDeviceApprovalRequest = NostrIdentityDeviceApprovalRequest;
export type DriveDeviceApprovalRequest = FullDriveDeviceApprovalRequest;
export type LocalDriveDeviceApprovalRequest = LocalNostrIdentityDeviceApprovalRequest;
export type DriveDeviceApprovalBootstrap = DeviceApprovalBootstrap;

export interface PendingDriveDeviceApproval {
  request: FullDriveDeviceApprovalRequest;
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
  request: LocalDriveDeviceApprovalRequest;
  url: string;
  label?: string;
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
  requestedAt?: number;
  label?: string;
  profileId?: NostrIdentityId;
  adminAppKeyPubkey?: string;
} = {}): DriveDeviceApprovalDraft {
  const appKeySecretKey = options.appKeySecretKey ?? generateSecretKey();
  const request = createNostrIdentityDeviceApprovalRequest({
    deviceAppKeySecretKey: appKeySecretKey,
    ...(options.requestSecretKey ? { requestSecretKey: options.requestSecretKey } : {}),
    requestedAt: options.requestedAt ?? Math.floor(Date.now() / 1000),
    requestType: DEVICE_APPROVAL_REQUEST_TYPE,
    resources: DRIVE_DEVICE_APPROVAL_RESOURCES.map((resource) => ({ ...resource })),
    expiresAt: (options.requestedAt ?? Math.floor(Date.now() / 1000)) + 15 * 60,
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.adminAppKeyPubkey ? { adminAppKeyPubkey: options.adminAppKeyPubkey } : {}),
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  });
  return {
    appKeySecretKey,
    request,
    url: encodeDriveDeviceApprovalBootstrap(createDeviceApprovalBootstrap(request)),
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  };
}

export function encodeDriveDeviceApprovalBootstrap(bootstrap: DriveDeviceApprovalBootstrap): string {
  return encodeDeviceApprovalBootstrap(bootstrap);
}

export function parseDriveDeviceApprovalBootstrap(input: string): DriveDeviceApprovalBootstrap | null {
  const value = input.trim().replace(/^nostr:/i, '');
  return parseDeviceApprovalBootstrap(value);
}

export function isCompleteDriveDeviceApprovalBootstrapInput(input: string): boolean {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value || /\s/.test(value)) return false;
  return parseDriveDeviceApprovalBootstrap(value) !== null;
}

export function pendingDriveDeviceApprovalFromDraft(
  draft: Pick<DriveDeviceApprovalDraft, 'request'>,
): PendingDriveDeviceApproval {
  return {
    request: serializableDriveDeviceApprovalRequest(draft.request),
    requestSecretKeyNsec: nip19.nsecEncode(draft.request.requestSecretKey),
  };
}

export function driveDeviceApprovalRequestSecretKey(pending: PendingDriveDeviceApproval): Uint8Array {
  const decoded = nip19.decode(pending.requestSecretKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Stored device approval request secret is not an nsec');
  }
  const secretKey = decoded.data as Uint8Array;
  if (getPublicKey(secretKey) !== pending.request.requestPubkey) {
    throw new Error('Stored device approval request secret does not match the request pubkey');
  }
  return secretKey;
}

export { pubkeyToNpub, npubToPubkey };

function serializableDriveDeviceApprovalRequest(
  request: LocalDriveDeviceApprovalRequest,
): FullDriveDeviceApprovalRequest {
  return {
    requestPubkey: request.requestPubkey,
    deviceAppKeyPubkey: request.deviceAppKeyPubkey,
    requestSecret: request.requestSecret,
    deviceAppKeyProof: request.deviceAppKeyProof,
    requestedAt: request.requestedAt,
    ...(request.requestType ? { requestType: request.requestType } : {}),
    ...(request.resources ? { resources: request.resources.map((resource) => ({ ...resource })) } : {}),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    ...(request.profileId ? { profileId: request.profileId } : {}),
    ...(request.adminAppKeyPubkey ? { adminAppKeyPubkey: request.adminAppKeyPubkey } : {}),
    ...(request.label ? { label: request.label } : {}),
  };
}

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
