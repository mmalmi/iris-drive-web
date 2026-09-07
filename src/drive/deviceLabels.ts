import {
  NOSTR_IDENTITY_ENCRYPTED_DEVICE_LABELS_FACT,
  NOSTR_IDENTITY_ENCRYPTED_DEVICE_LABELS_SCHEMA,
  encryptedDeviceLabelPayloadsFromNostrIdentityRosterOpEvent,
  type NostrIdentityEncryptedDeviceLabelsPayload,
} from 'nostr-social-graph';

export const DRIVE_DEVICE_LABEL_SCHEMA = NOSTR_IDENTITY_ENCRYPTED_DEVICE_LABELS_SCHEMA;
export const DRIVE_DEVICE_LABEL_STORAGE_KEY = 'iris:drive:device-labels:v1';
export const DRIVE_DEVICE_LABEL_FACT = NOSTR_IDENTITY_ENCRYPTED_DEVICE_LABELS_FACT;

export type DriveDeviceLabelPayload = NostrIdentityEncryptedDeviceLabelsPayload;

export function currentBrowserDeviceLabel(): string {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const userAgentData = (nav as (Navigator & {
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
      platform?: string;
    };
  }) | null)?.userAgentData;
  const userAgent = nav?.userAgent ?? '';
  const platform = userAgentData?.platform || nav?.platform || '';
  const browser = browserNameFromUserAgent(userAgent, userAgentData?.brands);
  const os = osNameFromUserAgent(userAgent, platform);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `${os} browser`;
  return 'Browser';
}

export function readStoredDeviceLabels(
  profileId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): Record<string, string> {
  const all = readAllStoredDeviceLabels(storage);
  return { ...(all[profileId] ?? {}) };
}

export function saveStoredDeviceLabel(
  profileId: string,
  devicePubkey: string,
  label: string | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): Record<string, string> {
  const trimmed = label?.trim() ?? '';
  const all = readAllStoredDeviceLabels(storage);
  const labels = { ...(all[profileId] ?? {}) };
  if (trimmed) {
    labels[devicePubkey] = trimmed;
  } else {
    delete labels[devicePubkey];
  }
  all[profileId] = labels;
  storage.setItem(DRIVE_DEVICE_LABEL_STORAGE_KEY, JSON.stringify(all));
  return labels;
}

export function saveStoredDeviceLabels(
  profileId: string,
  labels: Record<string, string>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): Record<string, string> {
  const all = readAllStoredDeviceLabels(storage);
  const normalized: Record<string, string> = {};
  for (const [pubkey, label] of Object.entries(labels)) {
    const trimmed = label.trim();
    if (trimmed) normalized[pubkey] = trimmed;
  }
  all[profileId] = normalized;
  storage.setItem(DRIVE_DEVICE_LABEL_STORAGE_KEY, JSON.stringify(all));
  return { ...normalized };
}

export function removeStoredDeviceLabels(
  profileId: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
): void {
  const all = readAllStoredDeviceLabels(storage);
  if (!(profileId in all)) return;
  delete all[profileId];
  if (Object.keys(all).length === 0) {
    storage.removeItem(DRIVE_DEVICE_LABEL_STORAGE_KEY);
  } else {
    storage.setItem(DRIVE_DEVICE_LABEL_STORAGE_KEY, JSON.stringify(all));
  }
}

export async function encryptDriveDeviceLabelsWithDck(
  payload: DriveDeviceLabelPayload,
  dckPlaintextHex: string,
): Promise<string> {
  const key = await importAesKey(dckPlaintextHex);
  const nonce = randomBytes(12);
  const plaintext = new TextEncoder().encode(stableStringify({
    schema: DRIVE_DEVICE_LABEL_SCHEMA,
    profileId: payload.profileId,
    secretEpoch: payload.secretEpoch,
    labels: normalizeLabels(payload.labels),
    updatedAt: payload.updatedAt,
  }));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plaintext),
  ));
  return `v1.${base64UrlEncode(nonce)}.${base64UrlEncode(encrypted)}`;
}

export async function decryptDriveDeviceLabelsWithDck(
  ciphertext: string,
  dckPlaintextHex: string,
): Promise<DriveDeviceLabelPayload | null> {
  const parts = ciphertext.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await importAesKey(dckPlaintextHex);
    const nonce = base64UrlDecode(parts[1]);
    const encrypted = base64UrlDecode(parts[2]);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
      key,
      toArrayBuffer(encrypted),
    );
    return parseDriveDeviceLabelPayload(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

export function encryptedDeviceLabelPayloadsFromEventJson(eventJson: string): string[] {
  try {
    const event = JSON.parse(eventJson) as { tags?: string[][] };
    return encryptedDeviceLabelPayloadsFromNostrIdentityRosterOpEvent({ tags: event.tags ?? [] });
  } catch {
    return [];
  }
}

export function parseDriveDeviceLabelPayload(input: string): DriveDeviceLabelPayload | null {
  try {
    const payload = JSON.parse(input) as Partial<DriveDeviceLabelPayload>;
    if (payload.schema !== DRIVE_DEVICE_LABEL_SCHEMA) return null;
    if (!payload.profileId || !payload.labels || typeof payload.labels !== 'object') return null;
    if (!Number.isFinite(payload.secretEpoch)) return null;
    return {
      schema: DRIVE_DEVICE_LABEL_SCHEMA,
      profileId: payload.profileId,
      secretEpoch: Number(payload.secretEpoch),
      labels: normalizeLabels(payload.labels),
      updatedAt: Number.isFinite(payload.updatedAt) ? Number(payload.updatedAt) : 0,
    };
  } catch {
    return null;
  }
}

function normalizeLabels(labels: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [pubkey, label] of Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) {
    const trimmed = label.trim();
    if (trimmed) normalized[pubkey] = trimmed;
  }
  return normalized;
}

async function importAesKey(dckPlaintextHex: string): Promise<CryptoKey> {
  const bytes = hexToBytes(dckPlaintextHex);
  if (bytes.length !== 32) throw new Error('Drive content key must be 32 bytes');
  return crypto.subtle.importKey('raw', toArrayBuffer(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Expected hex bytes');
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64url');
  }
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64url'));
  }
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  base64 += '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}

function readAllStoredDeviceLabels(storage: Pick<Storage, 'getItem'>): Record<string, Record<string, string>> {
  try {
    const raw = storage.getItem(DRIVE_DEVICE_LABEL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, Record<string, string>> = {};
    for (const [profileId, labels] of Object.entries(parsed)) {
      if (!labels || typeof labels !== 'object' || Array.isArray(labels)) continue;
      result[profileId] = {};
      for (const [pubkey, label] of Object.entries(labels)) {
        if (typeof label === 'string' && label.trim()) {
          result[profileId][pubkey] = label.trim();
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

function browserNameFromUserAgent(
  userAgent: string,
  brands: Array<{ brand: string; version: string }> | undefined,
): string {
  const brandNames = brands?.map((brand) => brand.brand).join(' ') ?? '';
  const combined = `${brandNames} ${userAgent}`;
  if (/Edg\//.test(userAgent) || /Microsoft Edge/i.test(brandNames)) return 'Edge';
  if (/OPR\//.test(userAgent) || /Opera/i.test(brandNames)) return 'Opera';
  if (/Firefox|FxiOS/i.test(combined)) return 'Firefox';
  if (/Google Chrome|Chrome|CriOS|Chromium/i.test(combined)) return 'Chrome';
  if (/Safari/i.test(userAgent) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/i.test(userAgent)) return 'Safari';
  return '';
}

function osNameFromUserAgent(userAgent: string, platform: string): string {
  const combined = `${platform} ${userAgent}`;
  if (/iPhone|iPad|iPod/i.test(combined)) return 'iOS';
  if (/Android/i.test(combined)) return 'Android';
  if (/Macintosh|Mac OS X|MacIntel|macOS/i.test(combined)) return 'macOS';
  if (/Windows/i.test(combined)) return 'Windows';
  if (/Linux/i.test(combined)) return 'Linux';
  return '';
}
