import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import type { IrisProfileId, SignedIrisProfileRosterOp } from './protocolTypes';

export const DEVICE_LINK_INVITE_PREFIX = 'https://drive.iris.to/invite/';
export const DEVICE_LINK_INVITE_VERSION = 1;

export interface DeviceLinkInvite {
  profileId: IrisProfileId;
  adminAppKeyPubkey: string;
  linkSecret: string;
}

export interface DeviceLinkRequest {
  profileId: IrisProfileId;
  adminAppKeyPubkey: string;
  deviceAppKeyPubkey: string;
  linkSecret?: string;
  linkSecretHash?: string;
  label?: string;
  requestedAt: number;
}

export type IrisIdentitySessionStatus = 'active' | 'pending_device_link';

export interface IrisIdentitySession {
  profileId: IrisProfileId;
  appKeyPubkey: string;
  appKeyNpub: string;
  appKeyNsec: string;
  status: IrisIdentitySessionStatus;
  rosterOps: SignedIrisProfileRosterOp[];
  createdAt: number;
  label?: string;
  pendingDeviceLink?: DeviceLinkRequest;
}

export interface StoredIrisIdentitySession {
  schema: 1;
  profileId: IrisProfileId;
  appKeyNsec: string;
  status: IrisIdentitySessionStatus;
  rosterOps: SignedIrisProfileRosterOp[];
  createdAt: number;
  label?: string;
  pendingDeviceLink?: DeviceLinkRequest;
}

type DeviceLinkInvitePayload = {
  v: number;
  profileId: string;
  adminAppKeyNpub: string;
  linkSecret: string;
};

export function encodeDeviceLinkInvite(invite: DeviceLinkInvite): string {
  const payload: DeviceLinkInvitePayload = {
    v: DEVICE_LINK_INVITE_VERSION,
    profileId: invite.profileId,
    adminAppKeyNpub: pubkeyToNpub(invite.adminAppKeyPubkey),
    linkSecret: requireNonEmpty(invite.linkSecret, 'link secret'),
  };
  return `${DEVICE_LINK_INVITE_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function parseDeviceLinkInvite(input: string): DeviceLinkInvite | null {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value) return null;
  const payload = payloadFromInviteUrl(value);
  if (payload === null) return null;
  try {
    return normalizeInvitePayload(JSON.parse(base64UrlDecode(payload)) as DeviceLinkInvitePayload);
  } catch {
    return null;
  }
}

export function isCompleteDeviceLinkInviteInput(input: string): boolean {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value || /\s/.test(value)) return false;
  if (payloadFromShareInviteUrl(value) !== null) return false;
  const payload = payloadFromInviteUrl(value);
  return payload !== null && payload.length >= 32;
}

export function createPendingDeviceLinkSession(options: {
  invite: DeviceLinkInvite;
  appKeySecretKey?: Uint8Array;
  requestedAt?: number;
  label?: string;
}): IrisIdentitySession {
  const appKeySecretKey = options.appKeySecretKey ?? generateSecretKey();
  const appKeyPubkey = getPublicKey(appKeySecretKey);
  const requestedAt = options.requestedAt ?? Math.floor(Date.now() / 1000);
  const pendingDeviceLink: DeviceLinkRequest = {
    profileId: options.invite.profileId,
    adminAppKeyPubkey: options.invite.adminAppKeyPubkey,
    deviceAppKeyPubkey: appKeyPubkey,
    linkSecret: options.invite.linkSecret,
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

export function pubkeyToNpub(pubkey: string): string {
  return nip19.npubEncode(requirePubkey(pubkey, 'pubkey'));
}

export function npubToPubkey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (!trimmed.startsWith('npub1')) return null;
  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === 'npub' && typeof decoded.data === 'string'
      ? decoded.data.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function normalizeInvitePayload(payload: DeviceLinkInvitePayload): DeviceLinkInvite | null {
  if (payload.v !== DEVICE_LINK_INVITE_VERSION) return null;
  if (!payload.profileId || !payload.adminAppKeyNpub || !payload.linkSecret) return null;
  const adminAppKeyPubkey = npubToPubkey(payload.adminAppKeyNpub);
  if (!adminAppKeyPubkey) return null;
  return {
    profileId: payload.profileId,
    adminAppKeyPubkey,
    linkSecret: requireNonEmpty(payload.linkSecret, 'link secret'),
  };
}

function payloadFromInviteUrl(input: string): string | null {
  const lower = input.toLowerCase();
  if (!lower.startsWith(DEVICE_LINK_INVITE_PREFIX)) return null;
  return input.slice(DEVICE_LINK_INVITE_PREFIX.length).split(/[?#]/, 1)[0].trim();
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

function base64UrlEncode(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64url');
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): string {
  if (looksLikePlaceholder(value)) throw new Error('device link invite is a placeholder');
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64url').toString('utf8');
  }
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes('...') || trimmed === '<code>' || trimmed === '<payload>' || trimmed === '<invite>';
}

function requirePubkey(value: string, label: string): string {
  const normalized = npubToPubkey(value);
  if (!normalized) throw new Error(`${label} pubkey must be npub or 64-char hex`);
  return normalized;
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}
