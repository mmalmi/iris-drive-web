import {
  finalizeEvent,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate,
} from 'nostr-tools';
import { fromHex, toHex, type CID } from '@hashtree/core';
import {
  D_TAG_APP_KEYS,
  KIND_APP_KEYS,
  KIND_DRIVE_ROOT,
  type AppKeysSnapshot,
  type AppKeysWireContent,
  type BuildDriveRootEventOptions,
  type DriveRootEventPreview,
  type DriveRootRef,
  type DriveRootWireContent,
  type ParsedDriveRootEvent,
} from './protocolTypes';
import {
  compareNumbers,
  currentUnixSeconds,
  parseAppKeyEntries,
  parseObject,
  parseObserved,
  parseRootParents,
  readNumber,
  readOptionalString,
  readStringRecord,
  requireDriveRootKind,
  requireIdentifier,
  requireKind,
  requireValidSignature,
  sortRecord,
  isHex32,
  isUuid,
} from './protocolJson';

export function driveRootDTag(rootScopeId: string, driveId: string): string {
  return `iris-drive/${rootScopeId}/${driveId}/root`;
}

export function buildAppKeysEventTemplate(snapshot: AppKeysSnapshot): EventTemplate {
  const content: AppKeysWireContent = {
    devices: snapshot.app_keys,
    dck_generation: snapshot.dck_generation,
    wrapped_dck: snapshot.wrapped_dck,
  };

  return {
    kind: KIND_APP_KEYS,
    content: JSON.stringify(content),
    created_at: snapshot.created_at,
    tags: [['d', D_TAG_APP_KEYS]],
  };
}

export function buildAppKeysEvent(snapshot: AppKeysSnapshot, ownerSecretKey: Uint8Array): Event {
  return finalizeEvent(buildAppKeysEventTemplate(snapshot), ownerSecretKey);
}

export function wrapDriveContentKeyForAppKeys(
  ownerSecretKey: Uint8Array,
  dckPlaintext: string,
  appKeyPubkeys: string[],
): Record<string, string> {
  const wrapped: Record<string, string> = {};
  for (const pubkey of Array.from(new Set(appKeyPubkeys)).sort()) {
    const conversationKey = nip44.v2.utils.getConversationKey(ownerSecretKey, pubkey);
    wrapped[pubkey] = nip44.v2.encrypt(dckPlaintext, conversationKey);
  }
  return wrapped;
}

export function parseAppKeysEvent(event: Event): AppKeysSnapshot {
  requireKind(event, KIND_APP_KEYS);
  const dTag = requireIdentifier(event);
  if (dTag !== D_TAG_APP_KEYS) {
    throw new Error(`invalid AppKeys d tag: ${dTag}`);
  }
  requireValidSignature(event);

  const content = parseObject(event.content);
  const appKeys = parseAppKeyEntries(content.devices);
  return {
    owner_pubkey: event.pubkey,
    created_at: event.created_at,
    app_keys: appKeys,
    dck_generation: readNumber(content.dck_generation, 0),
    wrapped_dck: readStringRecord(content.wrapped_dck),
  };
}

export function buildDriveRootEvent(options: BuildDriveRootEventOptions): Event {
  const rootKey = options.root.key;
  if (!rootKey) {
    throw new Error('drive root must be encrypted');
  }

  const devicePubkey = getPublicKey(options.deviceSecretKey);
  const rootKeyHex = toHex(rootKey);
  const authorizedAppKeyPubkeys = options.authorizedAppKeyPubkeys
    ?? options.authorizedDevicePubkeys
    ?? [];
  const recipients = Array.from(
    new Set([...authorizedAppKeyPubkeys, devicePubkey]),
  ).sort();
  const rootKeyWraps: Record<string, string> = {};

  for (const recipient of recipients) {
    const conversationKey = nip44.v2.utils.getConversationKey(options.deviceSecretKey, recipient);
    rootKeyWraps[recipient] = nip44.v2.encrypt(rootKeyHex, conversationKey);
  }

  const content: DriveRootWireContent = {
    root_hash: toHex(options.root.hash),
    root_key_wraps: rootKeyWraps,
    dck_generation: options.dckGeneration,
  };
  if (options.appKeySeq && options.appKeySeq > 0) {
    content.app_key_seq = options.appKeySeq;
  }
  if (options.deviceSeq && options.deviceSeq > 0) {
    content.device_seq = options.deviceSeq;
  }
  if (options.parents?.length) {
    content.parents = options.parents;
  }
  if (options.observed && Object.keys(options.observed).length > 0) {
    content.observed = sortRecord(options.observed);
  }

  return finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    content: JSON.stringify(content),
    created_at: options.publishedAt ?? currentUnixSeconds(),
    tags: [[
      'd',
      driveRootDTag(options.rootScopeId ?? options.ownerPubkeyHex ?? devicePubkey, options.driveId),
    ]],
  }, options.deviceSecretKey);
}

export function parseDriveRootEventPreview(event: Event): DriveRootEventPreview {
  const parts = parseDriveRootEventParts(event);
  const appKeySeq = rootAppKeySeq(parts.content);
  return {
    app_key_pubkey_hex: parts.devicePubkeyHex,
    device_pubkey_hex: parts.devicePubkeyHex,
    root_scope_id: parts.rootScopeId,
    owner_pubkey_hex: parts.ownerPubkeyHex,
    drive_id: parts.driveId,
    published_at: parts.publishedAt,
    dck_generation: parts.content.dck_generation,
    app_key_seq: appKeySeq,
    device_seq: appKeySeq,
  };
}

export function parseDriveRootEventForDevice(
  event: Event,
  deviceSecretKey: Uint8Array,
): ParsedDriveRootEvent {
  const parts = parseDriveRootEventParts(event);
  const devicePubkey = getPublicKey(deviceSecretKey);
  const root = resolveRootCid(parts.content, event.pubkey, devicePubkey, deviceSecretKey);
  const appKeySeq = rootAppKeySeq(parts.content);
  const rootRef: DriveRootRef = {
    root,
    published_at: parts.publishedAt,
    dck_generation: parts.content.dck_generation,
    app_key_seq: appKeySeq,
    device_seq: appKeySeq,
    parents: parts.content.parents ?? [],
    observed: parts.content.observed ?? {},
    materialized_only: false,
  };

  return {
    app_key_pubkey_hex: parts.devicePubkeyHex,
    device_pubkey_hex: parts.devicePubkeyHex,
    root_scope_id: parts.rootScopeId,
    owner_pubkey_hex: parts.ownerPubkeyHex,
    drive_id: parts.driveId,
    published_at: parts.publishedAt,
    dck_generation: parts.content.dck_generation,
    app_key_seq: appKeySeq,
    device_seq: appKeySeq,
    root,
    rootRef,
  };
}

export function isDriveRootEventNewer(candidate: Event, current: Event): boolean {
  try {
    const a = parseDriveRootEventPreview(candidate);
    const b = parseDriveRootEventPreview(current);
    return compareNumbers(a.device_seq, b.device_seq)
      || (a.device_seq === b.device_seq && compareNumbers(a.published_at, b.published_at))
      || (
        a.device_seq === b.device_seq
        && a.published_at === b.published_at
        && compareNumbers(a.dck_generation, b.dck_generation)
      );
  } catch {
    return candidate.created_at > current.created_at;
  }
}

export function parseDriveRootEventParts(event: Event): {
  devicePubkeyHex: string;
  rootScopeId: string;
  ownerPubkeyHex: string;
  driveId: string;
  content: DriveRootWireContent;
  publishedAt: number;
} {
  requireDriveRootKind(event);
  const [rootScopeId, driveId] = parseDriveRootDTag(requireIdentifier(event));
  requireValidSignature(event);
  return {
    devicePubkeyHex: event.pubkey,
    rootScopeId,
    ownerPubkeyHex: rootScopeId,
    driveId,
    content: parseDriveRootContent(event.content),
    publishedAt: event.created_at,
  };
}

export function rootAppKeySeq(content: DriveRootWireContent): number {
  return content.app_key_seq && content.app_key_seq > 0
    ? content.app_key_seq
    : content.device_seq ?? 0;
}

export function parseDriveRootDTag(dTag: string): [string, string] {
  const withoutPrefix = dTag.startsWith('iris-drive/')
    ? dTag.slice('iris-drive/'.length)
    : null;
  const inner = withoutPrefix?.endsWith('/root')
    ? withoutPrefix.slice(0, -'/root'.length)
    : null;
  const splitAt = inner?.indexOf('/') ?? -1;
  if (!inner || splitAt <= 0 || splitAt === inner.length - 1) {
    throw new Error(`invalid drive-root d tag: ${dTag}`);
  }
  const rootScope = inner.slice(0, splitAt);
  const drive = inner.slice(splitAt + 1);
  if (!isHex32(rootScope) && !isUuid(rootScope)) {
    throw new Error(`invalid root scope in drive-root d tag: ${rootScope}`);
  }
  return [rootScope, drive];
}

export function parseDriveRootContent(contentJson: string): DriveRootWireContent {
  const content = parseObject(contentJson);
  const rootHash = readOptionalString(content.root_hash);
  const rootCid = readOptionalString(content.root_cid);
  if (!rootHash && !rootCid) {
    throw new Error('drive-root event has no root hash');
  }

  return {
    root_cid: rootCid,
    root_hash: rootHash,
    root_key_wraps: readStringRecord(content.root_key_wraps),
    dck_generation: readNumber(content.dck_generation, 0),
    app_key_seq: readNumber(content.app_key_seq, 0),
    device_seq: readNumber(content.device_seq, 0),
    parents: parseRootParents(content.parents),
    observed: parseObserved(content.observed),
  };
}

export function resolveRootCid(
  content: DriveRootWireContent,
  authorPubkey: string,
  devicePubkey: string,
  deviceSecretKey: Uint8Array,
): CID {
  if (!content.root_hash) {
    throw new Error('legacy root_cid-only drive roots need native CID parsing');
  }
  const ciphertext = content.root_key_wraps[devicePubkey];
  if (!ciphertext) {
    throw new Error('drive root key is unavailable for this device');
  }
  const conversationKey = nip44.v2.utils.getConversationKey(deviceSecretKey, authorPubkey);
  const keyHex = nip44.v2.decrypt(ciphertext, conversationKey);
  return {
    hash: fromHex(content.root_hash),
    key: fromHex(keyHex),
  };
}
