import { getPublicKey, nip19 } from 'nostr-tools';
import { normalizeHexPubkey } from 'nostr-social-graph';
import type { StoredNostrIdentitySession } from '../drive/protocol';

export const IRIS_IDENTITY_SESSION_STORAGE_KEY = 'iris:identity:session';
export const IRIS_IDENTITY_SESSIONS_STORAGE_KEY = 'iris:identity:sessions';

type IdentitySessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadStoredNostrIdentitySessions(
  storage: Pick<Storage, 'getItem'> = localStorage,
): Record<string, StoredNostrIdentitySession> {
  try {
    const raw = storage.getItem(IRIS_IDENTITY_SESSIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const sessions: Record<string, StoredNostrIdentitySession> = {};
    for (const [appKeyPubkey, stored] of Object.entries(parsed)) {
      const normalizedPubkey = normalizeHexPubkey(appKeyPubkey);
      if (!normalizedPubkey || !stored || typeof stored !== 'object') continue;
      sessions[normalizedPubkey] = stored as StoredNostrIdentitySession;
    }
    return sessions;
  } catch {
    return {};
  }
}

export function saveStoredNostrIdentitySessions(
  sessions: Record<string, StoredNostrIdentitySession>,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage,
): void {
  if (Object.keys(sessions).length === 0) {
    storage.removeItem(IRIS_IDENTITY_SESSIONS_STORAGE_KEY);
  } else {
    storage.setItem(IRIS_IDENTITY_SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  }
}

/** Removes only private session material belonging to the selected AppKey. */
export function removeStoredNostrIdentitySession(
  appKeyPubkey: string,
  storage: IdentitySessionStorage = localStorage,
): StoredNostrIdentitySession | null {
  const normalized = normalizeHexPubkey(appKeyPubkey);
  if (!normalized) return null;
  const sessions = loadStoredNostrIdentitySessions(storage);
  const removed = sessions[normalized] ?? null;
  delete sessions[normalized];
  saveStoredNostrIdentitySessions(sessions, storage);

  // The singleton is the active/legacy mirror. Clear it only if it belongs to
  // the removed AppKey; a non-active account removal must preserve it.
  const legacyRaw = storage.getItem(IRIS_IDENTITY_SESSION_STORAGE_KEY);
  if (legacyRaw && storedSessionAppKeyPubkey(legacyRaw) === normalized) {
    storage.removeItem(IRIS_IDENTITY_SESSION_STORAGE_KEY);
  }
  return removed;
}

function storedSessionAppKeyPubkey(raw: string): string | null {
  try {
    const stored = JSON.parse(raw) as { appKeyNsec?: unknown };
    if (typeof stored.appKeyNsec !== 'string') return null;
    const decoded = nip19.decode(stored.appKeyNsec);
    return decoded.type === 'nsec'
      ? getPublicKey(decoded.data as Uint8Array)
      : null;
  } catch {
    return null;
  }
}
