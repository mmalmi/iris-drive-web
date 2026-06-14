import { nip19 } from 'nostr-tools';

export interface UserIndexEntryInput {
  pubkey: string;
  name?: string;
  displayName?: string;
  nip05?: string;
  irisProfileId?: string;
  linkedNpubs?: string[];
  shareRecipientEvidenceJson?: string;
}

export interface UserIndexEntry extends UserIndexEntryInput {
  npub: string;
}

interface StoredUserIndexEntry {
  pubkey: string;
  name?: string;
  displayName?: string;
  nip05?: string;
  irisProfileId?: string;
  linkedNpubs?: string[];
  shareRecipientEvidenceJson?: string;
}

function encodeNpub(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

function decodeNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === 'npub' ? decoded.data : null;
  } catch {
    return null;
  }
}

export function getUserSearchTerms(entry: UserIndexEntryInput): string[] {
  const terms: string[] = [];

  const npub = encodeNpub(entry.pubkey);
  if (npub) {
    terms.push(npub.toLowerCase());
  }

  if (entry.name) {
    const nameParts = entry.name.toLowerCase().split(/\s+/).filter(part => part.length >= 2);
    terms.push(...nameParts);
  }

  if (entry.displayName && entry.displayName !== entry.name) {
    const displayParts = entry.displayName.toLowerCase().split(/\s+/).filter(part => part.length >= 2);
    terms.push(...displayParts);
  }

  if (entry.nip05) {
    const atIndex = entry.nip05.indexOf('@');
    const username = atIndex > 0 ? entry.nip05.slice(0, atIndex) : entry.nip05;
    if (username.length >= 2) {
      terms.push(username.toLowerCase());
    }
  }

  if (entry.irisProfileId) {
    terms.push(entry.irisProfileId.toLowerCase());
  }

  for (const linkedNpub of entry.linkedNpubs ?? []) {
    terms.push(linkedNpub.toLowerCase());
  }

  return [...new Set(terms)];
}

export function serializeStoredUserIndexEntry(entry: UserIndexEntryInput): string {
  const stored: StoredUserIndexEntry = {
    pubkey: entry.pubkey,
    name: entry.name,
    displayName: entry.displayName,
    nip05: entry.nip05,
    irisProfileId: entry.irisProfileId,
    linkedNpubs: entry.linkedNpubs?.filter(Boolean),
    shareRecipientEvidenceJson: entry.shareRecipientEvidenceJson,
  };

  return JSON.stringify(stored);
}

export function parseStoredUserIndexEntry(value: string): UserIndexEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }

  let pubkey = typeof parsed.pubkey === 'string' ? parsed.pubkey.trim() : '';
  const legacyNpub = typeof parsed.npub === 'string' ? parsed.npub.trim() : '';

  if (!pubkey && legacyNpub) {
    pubkey = decodeNpub(legacyNpub) ?? '';
  }

  if (!pubkey) {
    return null;
  }

  const npub = legacyNpub || encodeNpub(pubkey);
  if (!npub) {
    return null;
  }

  return {
    pubkey,
    npub,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    displayName: typeof parsed.displayName === 'string' ? parsed.displayName : undefined,
    nip05: typeof parsed.nip05 === 'string' ? parsed.nip05 : undefined,
    irisProfileId: typeof parsed.irisProfileId === 'string' ? parsed.irisProfileId : undefined,
    linkedNpubs: Array.isArray(parsed.linkedNpubs)
      ? parsed.linkedNpubs.filter((item): item is string => typeof item === 'string')
      : undefined,
    shareRecipientEvidenceJson: typeof parsed.shareRecipientEvidenceJson === 'string'
      ? parsed.shareRecipientEvidenceJson
      : undefined,
  };
}
