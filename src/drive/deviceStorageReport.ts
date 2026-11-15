/**
 * A device's report of how much of the Drive it holds, for the account's
 * other devices. It is built like the native app's shared folder list
 * (`share_index/event.rs` in iris-drive): one replaceable event per device,
 * encrypted with a fresh key wrapped for each of the account's devices.
 *
 * Relays see which device sent one and when, and the keys of the account's
 * devices it is wrapped for, as with the Drive's roots. Its only tag is a
 * `d` tag hashed from what it is and whose account, so they cannot tell it
 * from other Drive events or see the account in it. When a device takes in
 * changes it sends a new one, so relays can tell when a device that only
 * reads is online, which FIPS discovery tells them too.
 */
import { finalizeEvent, getPublicKey, nip44, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { KIND_DRIVE_ROOT } from './protocolTypes';

export const DEVICE_STORAGE_LABEL = 'iris-drive/device-storage';
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_FOLDERS = 64;
const MAX_NAME = 255;
const MAX_DEPTH = 8;
const MAX_DEVICES = 256;
const NONCE_LEN = 12;

export interface DeviceStorageFolder {
  /** Names from the top of the Drive down. */
  path: string[];
  /** Size of the files in it, subfolders included. */
  bytes: number;
  /** How much of that the device holds. */
  held: number;
}

export interface DeviceStorageFiles {
  files: number;
  bytes: number;
  held: number;
}

export interface DeviceStorageReport {
  v: 1;
  /** Unix seconds. */
  measured_at: number;
  /** What kind of app: `web`, `macos`, `ios`, `android`, `windows` or `linux`. */
  app: string;
  /** The Drive version measured, as the hex hash of its root. */
  root: string;
  files: number;
  /** Size of all files in the Drive. */
  file_bytes: number;
  /** Files whose whole content the device holds. */
  held_files: number;
  held_bytes: number;
  /** Everything the app stores on the device, the Drive and more. */
  stored_bytes: number;
  /** The most the app may store there, when it has a limit. */
  capacity_bytes?: number;
  /** Folders that could not be read when measuring. */
  unread_folders?: number;
  /**
   * The newest version of each other device's Drive this one had taken in,
   * by the device's key: the `app_key_seq` of that device's root.
   */
  seen?: Record<string, number>;
  /** Files at the top of the Drive, in no folder. */
  loose?: DeviceStorageFiles;
  /**
   * The folders that make up a real share of the Drive, a folder before its
   * subfolders, larger ones first; the rest are not listed.
   */
  folders?: DeviceStorageFolder[];
}

interface Wire {
  v: 1;
  /** The report's key, hex, wrapped for each device with NIP-44. */
  key_wraps: Record<string, string>;
  /** `nonce.ciphertext`, base64url, AES-256-GCM. */
  data: string;
}

/** The same for every device of the account, and telling nothing of it or of what the event is. */
export function deviceStorageDTag(profileId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${DEVICE_STORAGE_LABEL}\n${profileId}`)));
}

/** Every device's report for the account `profileId`; whose they are is checked on reading. */
export function deviceStorageFilter(profileId: string): Filter {
  return { kinds: [KIND_DRIVE_ROOT], '#d': [deviceStorageDTag(profileId)] };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

function aesKey(key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buffer(key), 'AES-GCM', false, [usage]);
}

export async function buildDeviceStorageEvent(
  deviceSecretKey: Uint8Array,
  profileId: string,
  report: DeviceStorageReport,
  recipients: string[],
  createdAt = Math.floor(Date.now() / 1000),
): Promise<Event> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(report));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buffer(nonce) },
    await aesKey(key, 'encrypt'),
    buffer(plaintext),
  ));
  const keyWraps: Record<string, string> = {};
  for (const recipient of [...new Set([...recipients, getPublicKey(deviceSecretKey)])].sort()) {
    keyWraps[recipient] = nip44.encrypt(bytesToHex(key), nip44.getConversationKey(deviceSecretKey, recipient));
  }
  const wire: Wire = { v: 1, key_wraps: keyWraps, data: `${base64Url(nonce)}.${base64Url(ciphertext)}` };
  return finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    created_at: createdAt,
    content: JSON.stringify(wire),
    tags: [['d', deviceStorageDTag(profileId)]],
  }, deviceSecretKey);
}

const count = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
);

/** The report with every field checked; null when it is not one. */
export function readDeviceStorageReport(value: unknown): DeviceStorageReport | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const numbers = ['measured_at', 'files', 'file_bytes', 'held_files', 'held_bytes', 'stored_bytes'] as const;
  if (raw.v !== 1 || numbers.some((name) => count(raw[name]) === null)) return null;
  if (typeof raw.root !== 'string' || !/^[0-9a-f]{64}$/.test(raw.root)) return null;
  const report: DeviceStorageReport = {
    v: 1,
    measured_at: raw.measured_at as number,
    app: typeof raw.app === 'string' ? raw.app.slice(0, 32) : '',
    root: raw.root,
    files: raw.files as number,
    file_bytes: raw.file_bytes as number,
    held_files: Math.min(raw.held_files as number, raw.files as number),
    held_bytes: Math.min(raw.held_bytes as number, raw.file_bytes as number),
    stored_bytes: raw.stored_bytes as number,
  };
  const capacity = count(raw.capacity_bytes);
  if (capacity !== null) report.capacity_bytes = capacity;
  const unread = count(raw.unread_folders);
  if (unread) report.unread_folders = unread;
  if (raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) {
    const seen = Object.entries(raw.seen as Record<string, unknown>)
      .slice(0, MAX_DEVICES)
      .filter(([device, seq]) => /^[0-9a-f]{64}$/.test(device) && count(seq) !== null);
    report.seen = Object.fromEntries(seen) as Record<string, number>;
  }
  const loose = raw.loose as Record<string, unknown> | null | undefined;
  const looseFiles = count(loose?.files);
  const looseBytes = count(loose?.bytes);
  const looseHeld = count(loose?.held);
  if (looseFiles !== null && looseBytes !== null && looseHeld !== null) {
    report.loose = { files: looseFiles, bytes: looseBytes, held: Math.min(looseHeld, looseBytes) };
  }
  if (Array.isArray(raw.folders)) {
    report.folders = raw.folders.slice(0, MAX_FOLDERS).flatMap((item: unknown) => {
      const folder = item as Record<string, unknown> | null;
      const bytes = count(folder?.bytes);
      const held = count(folder?.held);
      const path = folder?.path;
      if (!Array.isArray(path) || path.length === 0 || path.length > MAX_DEPTH) return [];
      if (path.some((name) => typeof name !== 'string') || bytes === null || held === null) return [];
      return [{ path: (path as string[]).map((name) => name.slice(0, MAX_NAME)), bytes, held: Math.min(held, bytes) }];
    });
  }
  return report;
}

const tagValue = (event: Event, name: string) => event.tags.find((tag) => tag[0] === name)?.[1];

export function isDeviceStorageEvent(event: Event, profileId: string): boolean {
  return event.kind === KIND_DRIVE_ROOT && tagValue(event, 'd') === deviceStorageDTag(profileId);
}

/**
 * The report in a signed event of the account `profileId`, opened with this
 * device's key; null when it is not one or was not wrapped for this device.
 * Whether its author is one of the account's devices is the caller's to check.
 */
export async function openDeviceStorageEvent(
  event: Event,
  profileId: string,
  deviceSecretKey: Uint8Array,
): Promise<DeviceStorageReport | null> {
  if (!isDeviceStorageEvent(event, profileId) || event.content.length > MAX_CONTENT_BYTES) return null;
  try {
    // A fresh copy: nostr-tools remembers on the object that it checked it, and a changed copy keeps that.
    const { id, pubkey, created_at, kind, tags, content, sig } = event;
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) return null;
    const wire = JSON.parse(event.content) as Partial<Wire>;
    const wrap = wire.v === 1 ? wire.key_wraps?.[getPublicKey(deviceSecretKey)] : undefined;
    const [nonce, ciphertext] = typeof wire.data === 'string' ? wire.data.split('.') : [];
    if (typeof wrap !== 'string' || !nonce || !ciphertext) return null;
    const key = hexToBytes(nip44.decrypt(wrap, nip44.getConversationKey(deviceSecretKey, event.pubkey)));
    const iv = fromBase64Url(nonce);
    if (key.length !== 32 || iv.length !== NONCE_LEN) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buffer(iv) },
      await aesKey(key, 'decrypt'),
      buffer(fromBase64Url(ciphertext)),
    );
    return readDeviceStorageReport(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    return null;
  }
}
