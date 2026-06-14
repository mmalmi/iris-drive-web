import { nip19 } from 'nostr-tools';

export const DRIVE_ROOT_NAME = 'main';
const NPUB_LENGTH = 63;
const INVITE_PREFIXES = [
  'iris-drive://invite/',
  'iris-drive:/invite/',
  'https://drive.iris.to/invite/',
];
const SHARE_INVITE_PREFIXES = [
  'iris-drive://share-invite/',
  'iris-drive:/share-invite/',
  'https://drive.iris.to/share-invite/',
];
const LEGACY_INVITE_PREFIXES = [
  'iris-drive://link-device',
  'iris-drive:/link-device',
  'https://drive.iris.to/link-device',
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
    return payloadFromInviteUrl(value)!.length >= 32;
  }
  if (payloadFromShareInviteUrl(value) !== null) {
    return false;
  }
  if (legacyInviteQuery(value) !== null) {
    const params = new URLSearchParams(legacyInviteQuery(value)!);
    return Boolean(params.get('owner') && params.get('admin') && params.get('secret'));
  }
  if (value.startsWith('{')) {
    return ownerNpubFromDeviceLinkInvite(value) !== null;
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
  const payload = payloadFromInviteUrl(input);
  if (payload !== null) {
    return ownerNpubFromInvitePayload(payload);
  }

  if (input.startsWith('{')) {
    return ownerNpubFromInviteJson(input);
  }

  const query = legacyInviteQuery(input);
  if (query !== null) {
    const params = new URLSearchParams(query);
    return normalizePubkeyToNpub(params.get('owner') ?? '');
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

function legacyInviteQuery(input: string): string | null {
  const lower = input.toLowerCase();
  const prefix = LEGACY_INVITE_PREFIXES.find((candidate) => lower.startsWith(candidate));
  if (!prefix) return null;
  const rest = input.slice(prefix.length);
  return rest.startsWith('?') ? rest.slice(1) : null;
}

function ownerNpubFromInvitePayload(payload: string): string | null {
  try {
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    base64 += '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return ownerNpubFromInviteJson(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function ownerNpubFromInviteJson(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const owner = readString(parsed.ownerNpub)
      ?? readString(parsed.owner_npub)
      ?? readString(parsed.owner);
    return normalizePubkeyToNpub(owner ?? '');
  } catch {
    return null;
  }
}

function normalizePubkeyToNpub(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('npub1')) {
    const decoded = nip19.decode(trimmed);
    return decoded.type === 'npub' && typeof decoded.data === 'string'
      ? nip19.npubEncode(decoded.data)
      : null;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return nip19.npubEncode(trimmed.toLowerCase());
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
