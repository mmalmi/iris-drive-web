import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  createNostrIdentityDeviceApprovalRequest,
  encodeCompactNostrIdentityDeviceApprovalRequest,
  encodeNostrIdentityDeviceApprovalRequest,
  parseCompactNostrIdentityDeviceApprovalRequest,
  parseNostrIdentityDeviceApprovalRequest,
  createNostrIdentityDeviceLinkInvite,
  encodeNostrIdentityDeviceLinkInvite,
  parseNostrIdentityDeviceLinkInvite,
  isCompleteNostrIdentityDeviceLinkInviteInput,
  pubkeyToNpub,
  npubToPubkey,
  type LocalNostrIdentityDeviceApprovalRequest,
  type NostrIdentityDeviceApprovalRequest,
  type NostrIdentityDeviceApprovalRequestedResource,
  type NostrIdentityDeviceLinkInvite,
  type NostrIdentityDeviceLinkRequest,
} from '@iris/identity';
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from './protocolTypes';

export const DEVICE_LINK_INVITE_PREFIX = 'https://drive.iris.to/invite/';
export const DEVICE_APPROVAL_REQUEST_PREFIX = 'https://drive.iris.to/approve-device/';
export const DEVICE_APPROVAL_COMPACT_PREFIX = 'iris-drive://app-key-link';
export const DEVICE_LINK_INVITE_VERSION = 1;
export const DEVICE_APPROVAL_REQUEST_TYPE = 'device_link';

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
];

export type DeviceLinkInvite = NostrIdentityDeviceLinkInvite;
export type DeviceLinkRequest = NostrIdentityDeviceLinkRequest;
export type FullDriveDeviceApprovalRequest = NostrIdentityDeviceApprovalRequest;
export type DriveDeviceApprovalRequest = FullDriveDeviceApprovalRequest | CompactDriveDeviceApprovalRequest;
export type LocalDriveDeviceApprovalRequest = LocalNostrIdentityDeviceApprovalRequest;

export interface PendingDriveDeviceApproval {
  request: FullDriveDeviceApprovalRequest;
  requestSecretKeyNsec: string;
}

export interface CompactDriveDeviceApprovalRequest {
  format: 'compact_app_key_link';
  deviceAppKeyPubkey: string;
  requestType: typeof DEVICE_APPROVAL_REQUEST_TYPE;
  resources: typeof DRIVE_DEVICE_APPROVAL_RESOURCES;
  requestedAt: number;
  label?: string;
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
    url: encodeCompactDriveDeviceApprovalRequest(request),
    ...(options.label?.trim() ? { label: options.label.trim() } : {}),
  };
}

export function encodeDriveDeviceApprovalRequest(request: FullDriveDeviceApprovalRequest): string {
  return encodeNostrIdentityDeviceApprovalRequest(request, { prefix: DEVICE_APPROVAL_REQUEST_PREFIX });
}

export function encodeCompactDriveDeviceApprovalRequest(
  request: Pick<FullDriveDeviceApprovalRequest, 'deviceAppKeyPubkey' | 'label'>,
): string {
  let url = encodeCompactNostrIdentityDeviceApprovalRequest(request.deviceAppKeyPubkey, {
    prefix: DEVICE_APPROVAL_COMPACT_PREFIX,
  });
  const label = normalizeCompactLabel(request.label);
  if (label) {
    url += `&label=${encodeCompactQueryValue(label)}`;
  }
  return url;
}

export function parseDriveDeviceApprovalRequest(input: string): DriveDeviceApprovalRequest | null {
  const value = input.trim().replace(/^nostr:/i, '');
  const compact = parseCompactDriveDeviceApprovalRequest(value);
  if (compact) return compact;
  return parseNostrIdentityDeviceApprovalRequest(value, {
    prefixes: [DEVICE_APPROVAL_REQUEST_PREFIX],
  });
}

export function isCompleteDriveDeviceApprovalRequestInput(input: string): boolean {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value || /\s/.test(value)) return false;
  return parseDriveDeviceApprovalRequest(value) !== null;
}

export function isCompactDriveDeviceApprovalRequest(
  request: DriveDeviceApprovalRequest,
): request is CompactDriveDeviceApprovalRequest {
  return 'format' in request && request.format === 'compact_app_key_link';
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

function parseCompactDriveDeviceApprovalRequest(input: string): CompactDriveDeviceApprovalRequest | null {
  const compact = parseCompactNostrIdentityDeviceApprovalRequest(input, {
    prefixes: [DEVICE_APPROVAL_COMPACT_PREFIX, 'iris-drive:/app-key-link?'],
  });
  if (!compact) return null;
  const label = compactLabelFromUrl(input);
  return {
    format: 'compact_app_key_link',
    deviceAppKeyPubkey: compact.deviceAppKeyPubkey,
    requestType: DEVICE_APPROVAL_REQUEST_TYPE,
    resources: DRIVE_DEVICE_APPROVAL_RESOURCES,
    requestedAt: 0,
    ...(label ? { label } : {}),
  };
}

function compactLabelFromUrl(input: string): string | null {
  const query = input.trim().split('?', 2)[1]?.split('#', 1)[0] ?? '';
  if (!query) return null;
  for (const part of query.split('&')) {
    const [key, value = ''] = part.split('=', 2);
    if (key.toLowerCase() === 'label') {
      return normalizeCompactLabel(decodeCompactQueryValue(value));
    }
  }
  return null;
}

function normalizeCompactLabel(label: string | undefined): string | null {
  const normalized = label
    ?.split(/\s+/u)
    .join(' ')
    .trim()
    .replace(/^[.-]+|[.-]+$/gu, '')
    .trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, 64).join('');
}

function encodeCompactQueryValue(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => (
      (byte >= 0x30 && byte <= 0x39)
        || (byte >= 0x41 && byte <= 0x5a)
        || (byte >= 0x61 && byte <= 0x7a)
        || byte === 0x2d
        || byte === 0x2e
        || byte === 0x5f
        || byte === 0x7e
    )
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

function decodeCompactQueryValue(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' '));
  } catch {
    return value;
  }
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
