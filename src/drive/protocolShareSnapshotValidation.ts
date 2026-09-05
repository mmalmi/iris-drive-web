import type { Event } from 'nostr-tools';
import type { ShareAccessSnapshot, ShareInviteBundle } from './protocolTypes';
import {
  isRecord, isHex32, requireIdentifier, requireKind, requireValidSignature, stableStringify,
} from './protocolJson';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { sharedFolderAppKeyCanAdmin } from './protocolShareAccess';

export function validateNativeShareInvite(bundle: ShareInviteBundle): void {
  fields(bundle, 'schema shared_folder recipient_profile_id role representative_npub_hint access_snapshot created_at');
  uuid(bundle.recipient_profile_id);
  role(bundle.role);
  integer(bundle.created_at);
  optionalText(bundle.representative_npub_hint);
  const folder = bundle.shared_folder;
  fields(folder, 'share_id owner_profile_id source_path display_name local_role access pending_invites app_key_roots');
  uuid(folder.share_id);
  uuid(folder.owner_profile_id);
  role(folder.local_role);
  if (typeof folder.source_path !== 'string' || typeof folder.display_name !== 'string') {
    throw new Error('invalid share folder name or path');
  }
  const snapshot = bundle.access_snapshot;
  if (!snapshot) throw new Error('share access snapshot signature is required');
  fields(snapshot, 'snapshot_id signer_pubkey content event_json');
  const event = JSON.parse(snapshot.event_json) as Event;
  requireKind(event, 30078);
  requireValidSignature(event);
  if (!event.tags.some(([name, value]) => name === 'l' && value === 'iris-drive/share-access')) {
    throw new Error('share access snapshot label is missing');
  }
  const signedAccess = JSON.parse(event.content) as ShareAccessSnapshot;
  for (const access of [folder.access, snapshot.content, signedAccess]) {
    validateAccess(access, folder.share_id);
  }
  if (requireIdentifier(event) !== folder.share_id || event.created_at !== signedAccess.updated_at
    || event.id !== snapshot.snapshot_id || event.pubkey !== snapshot.signer_pubkey
    || normalizedAccess(signedAccess) !== normalizedAccess(snapshot.content)
    || normalizedAccess(signedAccess) !== normalizedAccess(folder.access!)) {
    throw new Error('signed share access snapshot does not match invite');
  }
  if (!sharedFolderAppKeyCanAdmin(folder, projectSharedFolderKeys(folder), event.pubkey)) {
    throw new Error('share access snapshot signer is not an active admin');
  }
}

function normalizedAccess(access: ShareAccessSnapshot): string {
  const key_epochs = Object.fromEntries(Object.entries(access.key_epochs ?? {}).map(([key, epoch]) => [
    key, { ...epoch, wrapped_secrets: epoch.wrapped_secrets ?? {} },
  ]));
  return stableStringify(JSON.parse(JSON.stringify(
    { grants: [], devices: {}, tombstones: {}, ...access, key_epochs },
    (_, value) => value === null ? undefined : value,
  )));
}

function validateAccess(value: unknown, shareId: string): asserts value is ShareAccessSnapshot {
  fields(value, 'schema resource_id updated_at grants devices tombstones key_epochs');
  if (value.schema !== 1 || value.resource_id !== shareId) {
    throw new Error('invalid share access snapshot schema or resource');
  }
  integer(value.updated_at);
  if (value.grants !== undefined && !Array.isArray(value.grants)) throw new Error('invalid share grants');
  for (const grant of (value.grants ?? []) as unknown[]) {
    fields(grant, 'target role status representative_npub_hint display_name');
    role(grant.role);
    if (!['active', 'pending', 'revoked'].includes(String(grant.status))) {
      throw new Error('invalid share grant role or status');
    }
    fields(grant.target, 'type id pubkey');
    if (grant.target.type === 'id') {
      uuid(grant.target.id);
    } else if (grant.target.type === 'pubkey') {
      pubkey(grant.target.pubkey);
    } else throw new Error('invalid share grant target');
    optionalText(grant.representative_npub_hint);
    optionalText(grant.display_name);
  }
  for (const [key, device] of entries(value.devices)) {
    fields(device, 'pubkey profile_id added_at label');
    pubkey(key);
    if (device.pubkey !== key) throw new Error('share device map key does not match device pubkey');
    identity(device.profile_id);
    integer(device.added_at);
    optionalText(device.label);
  }
  for (const [, tombstone] of entries(value.tombstones)) {
    fields(tombstone, 'pubkey profile_id removed_by_pubkey removed_at reason');
    pubkey(tombstone.pubkey);
    pubkey(tombstone.removed_by_pubkey);
    identity(tombstone.profile_id);
    integer(tombstone.removed_at);
    optionalText(tombstone.reason);
  }
  for (const [key, epoch] of entries(value.key_epochs)) {
    fields(epoch, 'epoch created_at signed_by_pubkey wrapped_secrets');
    if (!/^\d+$/.test(key)) throw new Error('invalid share key epoch');
    integer(epoch.epoch);
    integer(epoch.created_at);
    pubkey(epoch.signed_by_pubkey);
    for (const [recipient, wrap] of entries(epoch.wrapped_secrets)) {
      pubkey(recipient);
      if (typeof wrap !== 'string') throw new Error('invalid share key wrap');
    }
  }
}

function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !names.split(' ').includes(key))) {
    throw new Error('invalid share access snapshot fields');
  }
}

function entries(value: unknown): [string, unknown][] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error('invalid share access snapshot map');
  return Object.entries(value);
}

function pubkey(value: unknown): void {
  if (typeof value !== 'string' || !isHex32(value)) throw new Error('invalid share public key');
}

function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid share timestamp or epoch');
}

function optionalText(value: unknown): void {
  if (value != null && typeof value !== 'string') throw new Error('invalid share text');
}

function identity(value: unknown): void {
  if (value != null) uuid(value);
}

function uuid(value: unknown): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('invalid share identity');
  }
}

function role(value: unknown): void {
  if (value !== 'admin' && value !== 'editor' && value !== 'reader') throw new Error('invalid share role');
}
