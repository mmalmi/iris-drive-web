import { nip19 } from 'nostr-tools';

export function validateNpub(npub: string): { valid: boolean; error?: string } {
  if (!npub.trim()) {
    return { valid: false, error: 'Please enter an npub' };
  }

  if (!npub.startsWith('npub1') || npub.length !== 63) {
    return { valid: false, error: 'Invalid npub format. Must start with npub1 and be 63 characters.' };
  }

  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      return { valid: false, error: 'Invalid npub format' };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid npub' };
  }
}

export function extractNpubFromScan(text: string): string | null {
  const cleaned = text.trim();

  if (cleaned.startsWith('npub1') && cleaned.length === 63) {
    return cleaned;
  }

  const npubMatch = cleaned.match(/npub1[a-z0-9]{58}/i);
  if (npubMatch) {
    return npubMatch[0].toLowerCase();
  }

  if (/^[a-f0-9]{64}$/i.test(cleaned)) {
    try {
      return nip19.npubEncode(cleaned);
    } catch {
      return null;
    }
  }

  return null;
}

export function titleCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
