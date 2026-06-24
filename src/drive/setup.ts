import { nip19 } from 'nostr-tools';
import {
  isCompleteDeviceLinkInviteInput,
  parseDeviceLinkInvite,
  pubkeyToNpub,
} from './deviceLink';

export const DRIVE_ROOT_NAME = 'main';
const NPUB_LENGTH = 63;
const INVITE_PREFIXES = [
  'https://drive.iris.to/invite/',
];
const SHARE_INVITE_PREFIXES = [
  'iris-drive://share-invite/',
  'iris-drive:/share-invite/',
  'https://drive.iris.to/share-invite/',
];

export function driveRootPath(npub: string): string {
  return `/${encodeURIComponent(npub)}/${DRIVE_ROOT_NAME}`;
}

export function normalizeOwnerNpub(input: string): string | null {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value) return null;

  try {
    const inviteOwner = ownerNpubFromDeviceLinkInvite(value);
    if (inviteOwner) return inviteOwner;

    if (value.startsWith('npub1')) {
      const decoded = nip19.decode(value);
      return decoded.type === 'npub' && typeof decoded.data === 'string'
        ? nip19.npubEncode(decoded.data)
        : null;
    }

    if (/^[0-9a-f]{64}$/i.test(value)) {
      return nip19.npubEncode(value.toLowerCase());
    }
  } catch {
    return null;
  }

  return null;
}

export function isCompleteDeviceLinkOwnerInput(input: string): boolean {
  const value = input.trim().replace(/^nostr:/i, '');
  if (!value || /\s/.test(value)) return false;

  const lower = value.toLowerCase();
  if (lower.startsWith('npub1')) {
    return lower.length >= NPUB_LENGTH;
  }
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return true;
  }
  if (payloadFromInviteUrl(value) !== null) {
    return isCompleteDeviceLinkInviteInput(value);
  }
  if (payloadFromShareInviteUrl(value) !== null) {
    return false;
  }
  return false;
}

export function isCompleteShareInviteInput(input: string): boolean {
  const payload = payloadFromShareInviteUrl(input.trim().replace(/^nostr:/i, ''));
  return payload !== null && payload.length >= 32;
}

export function shareInvitePayload(input: string): string | null {
  return payloadFromShareInviteUrl(input.trim().replace(/^nostr:/i, ''));
}

function ownerNpubFromDeviceLinkInvite(input: string): string | null {
  if (payloadFromInviteUrl(input) !== null) {
    const canonicalInvite = parseDeviceLinkInvite(input);
    if (canonicalInvite) {
      return pubkeyToNpub(canonicalInvite.adminAppKeyPubkey);
    }
  }

  return null;
}

function payloadFromInviteUrl(input: string): string | null {
  const lower = input.toLowerCase();
  const prefix = INVITE_PREFIXES.find((candidate) => lower.startsWith(candidate));
  if (!prefix) return null;
  return input
    .slice(prefix.length)
    .split(/[?#]/, 1)[0]
    .trim();
}

function payloadFromShareInviteUrl(input: string): string | null {
  const lower = input.toLowerCase();
  const prefix = SHARE_INVITE_PREFIXES.find((candidate) => lower.startsWith(candidate));
  if (!prefix) return null;
  return input
    .slice(prefix.length)
    .split(/[?#]/, 1)[0]
    .trim();
}
