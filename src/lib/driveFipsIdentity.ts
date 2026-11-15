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
  /** Passed to the relay check; how old a relay's confirmation may be. */
  maxAgeMs?: number;
  /** When an answered check is repeated in the background (default: half of maxAgeMs). */
  refreshAfterMs?: number;
  refreshTimeoutMs?: number;
  /** How long until relays that did not answer, or a failed check, are asked again; doubles each time. */
  failedRetryMs?: number;
  onRefreshError?: (error: unknown) => void;
}

/**
 * Which of the account's own devices may exchange Drive events with this one
 * directly: the devices in the roster this device holds. Nothing waits for
 * relays, and no relay has to answer for devices to sync over FIPS.
 *
 * - The relays are asked in the background; every operation from every relay,
 *   from the live roster subscription and from the other devices over FIPS is
 *   merged into the held roster, so a revocation from any of them removes its
 *   device at once.
 * - Relays that did not answer, and failed checks, are asked again later and
 *   later. An answered check is repeated once `refreshAfterMs` old.
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
  let confirmedAt: number | null = null;
  let next: { fingerprint: string; at: number } | null = null;
  let retryWaitMs = retryMs;
  let pending = false;
  const later = () => {
    const wait = retryWaitMs;
    retryWaitMs = Math.min(retryWaitMs * 2, refreshAfterMs);
    return now() + wait;
  };

  const refresh = async (fingerprint: string): Promise<void> => {
    if (pending) return;
    pending = true;
    try {
      const check = await options.refreshRosterOps(options.identity.profileId, refreshTimeoutMs, { confirmedAt, maxAgeMs });
      if (check.status === 'unconfirmed' || check.confirmedAt === null) throw new Error('No relay confirmed the Drive roster');
      confirmedAt = check.confirmedAt;
      const allAnswered = check.status === 'confirmed' && check.unanswered.length === 0;
      if (allAnswered) retryWaitMs = retryMs;
      next = { fingerprint, at: allAnswered ? now() + refreshAfterMs : later() };
    } catch (error) {
      options.onRefreshError?.(error);
      next = { fingerprint, at: later() };
    } finally {
      pending = false;
    }
  };

  return async (): Promise<string[]> => {
    const session = matchingRosterSession(options);
    if (!session) return [];
    const fingerprint = rosterFingerprint(session.rosterOps);
    // A changed roster is checked with the relays behind, never waited for.
    if (!next || next.fingerprint !== fingerprint || now() >= next.at) void refresh(fingerprint);
    const pubkeys = authorizedDriveFipsAppKeyPubkeys(session.profileId, session.rosterOps);
    return pubkeys.includes(ownKey) ? pubkeys : [];
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
