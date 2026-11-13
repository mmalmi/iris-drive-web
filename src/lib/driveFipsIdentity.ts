import { toHex } from '@hashtree/core';
import { getPublicKey, nip19 } from 'nostr-tools';
import { projectNostrIdentityRoster } from '../drive/protocolProfileProjection';
import type { SignedNostrIdentityRosterOp } from '../drive/protocolTypes';

export interface DriveFipsIdentitySource {
  pubkey: string;
  nsec?: string;
  profileId?: string;
}

export interface ResolvedDriveFipsIdentity {
  appKeyPubkey: string;
  deviceSecretKey: string;
  profileId?: string;
}

export interface DriveFipsRosterSession {
  profileId: string;
  appKeyPubkey: string;
  status: string;
  rosterOps: SignedNostrIdentityRosterOp[];
}

export interface DriveFipsRosterAuthorizationOptions {
  identity: ResolvedDriveFipsIdentity & { profileId: string };
  getSession: () => DriveFipsRosterSession | null;
  refreshRosterOps: (
    profileId: string,
    timeoutMs: number,
  ) => Promise<SignedNostrIdentityRosterOp[]>;
  now?: () => number;
  /** How long a roster checked with the relays is trusted without another check. */
  maxAgeMs?: number;
  /** When a trusted roster is checked again in the background (default: half its age). */
  refreshAfterMs?: number;
  refreshTimeoutMs?: number;
  onRefreshError?: (error: unknown) => void;
}

/**
 * Keep private FIPS event admission bounded to a recently refreshed
 * roster. Live session changes invalidate the snapshot immediately; relay
 * refresh failure after expiry removes event peers instead of trusting stale
 * authorization indefinitely. Standard Hashtree block serving is independent.
 *
 * The live roster subscription keeps the session current, so the relays are
 * asked again only once a snapshot is `refreshAfterMs` old, in the background,
 * while the snapshot keeps answering until it expires.
 */
export function createDriveFipsRosterAuthorizationSource(
  options: DriveFipsRosterAuthorizationOptions,
): () => Promise<string[]> {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  const refreshAfterMs = Math.min(options.refreshAfterMs ?? Math.floor(maxAgeMs / 2), maxAgeMs);
  const refreshTimeoutMs = options.refreshTimeoutMs ?? 2_000;
  let snapshot: {
    fingerprint: string;
    refreshAt: number;
    expiresAt: number;
    pubkeys: string[];
  } | null = null;
  let pending: {
    fingerprint: string;
    promise: Promise<string[]>;
  } | null = null;
  const valid = (fingerprint: string) => snapshot?.fingerprint === fingerprint && now() < snapshot.expiresAt;

  const refresh = (fingerprint: string): Promise<string[]> => {
    if (pending?.fingerprint === fingerprint) return pending.promise;
    const promise = (async (): Promise<string[]> => {
      try {
        await options.refreshRosterOps(options.identity.profileId, refreshTimeoutMs);
        const current = matchingRosterSession(options);
        if (!current) {
          snapshot = null;
          return [];
        }
        const pubkeys = authorizedDriveFipsAppKeyPubkeys(
          current.profileId,
          current.rosterOps,
        );
        if (!pubkeys.includes(options.identity.appKeyPubkey)) {
          snapshot = null;
          return [];
        }
        const at = now();
        snapshot = {
          fingerprint: rosterFingerprint(current.rosterOps),
          refreshAt: at + refreshAfterMs,
          expiresAt: at + maxAgeMs,
          pubkeys,
        };
        return [...pubkeys];
      } catch (error) {
        options.onRefreshError?.(error);
        // A failed check in the background leaves the snapshot to its expiry.
        if (valid(fingerprint)) return [...snapshot!.pubkeys];
        snapshot = null;
        return [];
      }
    })();
    const pendingRefresh = { fingerprint, promise };
    pending = pendingRefresh;
    void promise.finally(() => {
      if (pending === pendingRefresh) pending = null;
    });
    return promise;
  };

  return async (): Promise<string[]> => {
    const session = matchingRosterSession(options);
    if (!session) {
      snapshot = null;
      return [];
    }
    const fingerprint = rosterFingerprint(session.rosterOps);
    if (valid(fingerprint)) {
      if (now() >= snapshot!.refreshAt) void refresh(fingerprint);
      return [...snapshot!.pubkeys];
    }
    return [...await refresh(fingerprint)];
  };
}

export function authorizedDriveFipsAppKeyPubkeys(
  profileId: string,
  rosterOps: SignedNostrIdentityRosterOp[],
): string[] {
  const projection = projectNostrIdentityRoster(profileId, rosterOps);
  return Object.values(projection.active_facets)
    .filter((facet) => facet.purposes?.includes('app_key'))
    .map((facet) => facet.pubkey.trim().toLowerCase())
    .filter((pubkey) => /^[0-9a-f]{64}$/.test(pubkey))
    .sort();
}

/**
 * Resolve and validate the FIPS identity for the currently selected Drive
 * AppKey. FIPS peer authentication must use the same key as Drive root
 * signing; an unrelated browser-local key cannot be authorized by native
 * clients.
 */
export function resolveDriveFipsIdentity(
  source: DriveFipsIdentitySource,
): ResolvedDriveFipsIdentity | null {
  const appKeyPubkey = source.pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(appKeyPubkey) || !source.nsec) return null;

  const secretKey = decodeSecretKey(source.nsec);
  if (!secretKey || getPublicKey(secretKey) !== appKeyPubkey) return null;

  const profileId = source.profileId?.trim();
  return {
    appKeyPubkey,
    deviceSecretKey: toHex(secretKey),
    ...(profileId ? { profileId } : {}),
  };
}

export function decodeDriveFipsSecretKey(secret: string | Uint8Array): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.byteLength !== 32) {
      throw new Error(`Drive AppKey secret must be 32 bytes, got ${secret.byteLength}`);
    }
    return new Uint8Array(secret);
  }

  const decoded = decodeSecretKey(secret);
  if (!decoded) throw new Error('Drive AppKey secret must be a 32-byte hex key or nsec');
  return decoded;
}

function matchingRosterSession(
  options: DriveFipsRosterAuthorizationOptions,
): DriveFipsRosterSession | null {
  const session = options.getSession();
  return session?.status === 'active'
    && session.profileId === options.identity.profileId
    && session.appKeyPubkey === options.identity.appKeyPubkey
    ? session
    : null;
}

function rosterFingerprint(rosterOps: readonly SignedNostrIdentityRosterOp[]): string {
  return rosterOps.map((op) => op.op_id).sort().join(':');
}

function decodeSecretKey(value: string): Uint8Array | null {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Uint8Array.from(
      { length: 32 },
      (_, index) => Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16),
    );
  }

  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === 'nsec' ? new Uint8Array(decoded.data as Uint8Array) : null;
  } catch {
    return null;
  }
}
