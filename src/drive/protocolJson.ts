import { verifyEvent, type Event } from 'nostr-tools';
import {
  KIND_DRIVE_ROOT,
  KIND_LEGACY_DRIVE_ROOT,
  type AppKeyEntry,
  type RootObservation,
  type RootParent,
} from './protocolTypes';

export function requireKind(event: Event, expected: number): void {
  if (event.kind !== expected) {
    throw new Error(`invalid event kind: expected ${expected}, got ${event.kind}`);
  }
}

export function requireDriveRootKind(event: Event): void {
  if (event.kind !== KIND_DRIVE_ROOT && event.kind !== KIND_LEGACY_DRIVE_ROOT) {
    throw new Error(`invalid event kind: expected ${KIND_DRIVE_ROOT}, got ${event.kind}`);
  }
}

export function requireIdentifier(event: Event): string {
  const tag = event.tags.find(([name]) => name === 'd');
  const identifier = tag?.[1];
  if (!identifier) {
    throw new Error('missing d tag');
  }
  return identifier;
}

export function requireValidSignature(event: Event): void {
  if (!verifyEvent(event)) {
    throw new Error('event signature verification failed');
  }
}

export function parseObject(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error('event content must be a JSON object');
  }
  return parsed;
}

export function parseAppKeyEntries(value: unknown): AppKeyEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('AppKey entry must be an object');
    }
    const pubkey = readRequiredString(entry.pubkey, 'AppKey pubkey');
    const addedAt = readNumber(entry.added_at, 0);
    const label = readOptionalString(entry.label);
    return label ? { pubkey, added_at: addedAt, label } : { pubkey, added_at: addedAt };
  });
}

export function parseRootParents(value: unknown): RootParent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('root parent must be an object');
    }
    const parent: RootParent = {
      root_cid: readRequiredString(entry.root_cid, 'parent root cid'),
    };
    const appKeyPubkey = readOptionalString(entry.app_key_pubkey);
    const deviceId = readOptionalString(entry.device_id);
    const appKeySeq = readOptionalNumber(entry.app_key_seq);
    const deviceSeq = readOptionalNumber(entry.device_seq);
    if (appKeyPubkey) parent.app_key_pubkey = appKeyPubkey;
    if (deviceId) parent.device_id = deviceId;
    if (appKeySeq !== undefined) parent.app_key_seq = appKeySeq;
    if (deviceSeq !== undefined) parent.device_seq = deviceSeq;
    return parent;
  });
}

export function parseObserved(value: unknown): Record<string, RootObservation> {
  if (!isRecord(value)) {
    return {};
  }
  const observed: Record<string, RootObservation> = {};
  for (const [deviceId, raw] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecord(raw)) {
      throw new Error('root observation must be an object');
    }
    const observation: RootObservation = {
      root_cid: readRequiredString(raw.root_cid, 'observed root cid'),
    };
    const appKeySeq = readOptionalNumber(raw.app_key_seq);
    const deviceSeq = readOptionalNumber(raw.device_seq);
    if (appKeySeq !== undefined) observation.app_key_seq = appKeySeq;
    if (deviceSeq !== undefined) observation.device_seq = deviceSeq;
    observed[deviceId] = observation;
  }
  return observed;
}

export function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof raw === 'string') {
      out[key] = raw;
    }
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function randomClientNonce(): string {
  return globalThis.crypto?.randomUUID?.() ?? `nonce-${Math.random().toString(36).slice(2)}`;
}

export function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`missing ${field}`);
  }
  return value;
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, T>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHex32(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function compareNumbers(a: number, b: number): boolean {
  return a > b;
}

export function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
