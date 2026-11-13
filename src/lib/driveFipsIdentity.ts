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

/** What a relay check of the roster found (see `decideRosterAdmission`). */
export interface DriveFipsRosterCheck {
  status: 'confirmed' | 'provisional' | 'unconfirmed';
  /** When a relay last confirmed the roster, or null. */
  confirmedAt: number | null;
  /** Relays that did not answer completely. */
  unanswered: string[];
}

export interface DriveFipsRosterAuthorizationOptions {
  identity: ResolvedDriveFipsIdentity & { profileId: string };
  getSession: () => DriveFipsRosterSession | null;
  refreshRosterOps: (
    profileId: string,
    timeoutMs: number,
    previous: { confirmedAt: number | null; maxAgeMs: number },
  ) => Promise<DriveFipsRosterCheck>;
  now?: () => number;
  /** How long a roster confirmed by a relay is trusted when no relay answers. */
  maxAgeMs?: number;
  /** When a confirmed roster is checked again in the background (default: half its age). */
  refreshAfterMs?: number;
  refreshTimeoutMs?: number;
  /** How long until relays that did not answer, or a failed check, are asked again; doubles each time. */
  failedRetryMs?: number;
  onRefreshError?: (error: unknown) => void;
}

/**
 * Which of the account's own devices may exchange Drive events with this one
 * directly. Nothing waits for the relays while a confirmed roster is held: the
 * answer comes from the roster this device holds, and the relays are asked in
 * the background.
 *
 * - The first relay that answers the roster query completely confirms it; every
 *   operation from every relay, and from the live roster subscription that
 *   keeps the session current, is merged with what is held, so a revocation
 *   from any of them removes its device at once.
 * - Relays that did not answer, and failed checks, are asked again later and
 *   later. A confirmed roster is checked again once `refreshAfterMs` old.
 * - With no relay answering for `maxAgeMs`, no device is admitted.
 * Standard Hashtree block serving is independent of this.
 */
export function createDriveFipsRosterAuthorizationSource(
  options: DriveFipsRosterAuthorizationOptions,
): () => Promise<string[]> {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 10 * 60_000;
  const refreshAfterMs = Math.min(options.refreshAfterMs ?? Math.floor(maxAgeMs / 2), maxAgeMs);
  const refreshTimeoutMs = options.refreshTimeoutMs ?? 2_000;
  const retryMs = options.failedRetryMs ?? 30_000;
  const ownKey = options.identity.appKeyPubkey;
  let snapshot: {
    fingerprint: string;
    pubkeys: string[];
    confirmedAt: number;
    refreshAt: number;
  } | null = null;
  let failure: { fingerprint: string; retryAt: number; waitMs: number } | null = null;
  let retryWaitMs = retryMs;
  let pending: { fingerprint: string; promise: Promise<string[]> } | null = null;
  const trusted = () => snapshot !== null && now() < snapshot.confirmedAt + maxAgeMs;
  const admitted = (pubkeys: string[]) => (pubkeys.includes(ownKey) ? [...pubkeys] : []);
  const nextWait = () => {
    const wait = retryWaitMs;
    retryWaitMs = Math.min(retryWaitMs * 2, refreshAfterMs);
    return wait;
  };

  const refresh = (fingerprint: string): Promise<string[]> => {
    if (pending?.fingerprint === fingerprint) return pending.promise;
    const promise = (async (): Promise<string[]> => {
      try {
        const check = await options.refreshRosterOps(options.identity.profileId, refreshTimeoutMs, {
          confirmedAt: snapshot?.confirmedAt ?? null,
          maxAgeMs,
        });
        // The check merged what the relays sent into the session; a revocation
        // that arrived meanwhile is in the session too.
        const current = matchingRosterSession(options);
        const pubkeys = current
          ? admitted(authorizedDriveFipsAppKeyPubkeys(current.profileId, current.rosterOps))
          : [];
        if (!current || check.status === 'unconfirmed' || check.confirmedAt === null || pubkeys.length === 0) {
          throw new Error('No relay confirmed the Drive roster');
        }
        failure = null;
        const allAnswered = check.status === 'confirmed' && check.unanswered.length === 0;
        if (allAnswered) retryWaitMs = retryMs;
        // Relays that did not answer are asked again soon; otherwise in a while.
        snapshot = {
          fingerprint: rosterFingerprint(current.rosterOps),
          pubkeys,
          confirmedAt: check.confirmedAt,
          refreshAt: now() + (allAnswered ? refreshAfterMs : nextWait()),
        };
        return [...pubkeys];
      } catch (error) {
        options.onRefreshError?.(error);
        if (trusted()) {
          // Keep answering from what is held until the confirmation is too old.
          snapshot!.refreshAt = now() + nextWait();
          return [...snapshot!.pubkeys];
        }
        snapshot = null;
        const waitMs = failure?.fingerprint === fingerprint
          ? Math.min(failure.waitMs * 2, maxAgeMs)
          : retryMs;
        failure = { fingerprint, retryAt: now() + waitMs, waitMs };
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
    if (trusted()) {
      if (snapshot!.fingerprint !== fingerprint) {
        // The live roster changed: a revoked device leaves and an approved one
        // joins now, and the relays are asked in the background.
        snapshot = {
          ...snapshot!,
          fingerprint,
          pubkeys: admitted(authorizedDriveFipsAppKeyPubkeys(session.profileId, session.rosterOps)),
        };
        void refresh(fingerprint);
      } else if (now() >= snapshot!.refreshAt) {
        void refresh(fingerprint);
      }
      return [...snapshot!.pubkeys];
    }
    if (failure?.fingerprint === fingerprint && now() < failure.retryAt) return [];
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
