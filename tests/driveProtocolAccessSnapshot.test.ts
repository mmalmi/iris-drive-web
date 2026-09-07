import { describe, expect, it } from 'vitest';
import nativeFixture from './fixtures/native-share-invite.json';
import { createDecipheriv } from 'node:crypto';
import { expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools';
import {
  encodeShareInvite, parseShareInvite, sharedFolderFromInviteForProfile,
  projectSharedFolderView, sharedFolderAuthorizedWriterPubkeys, sharedFolderKeyRecipientPubkeys,
  sharedFolderAppKeyWriteAuthorization,
  type ShareInviteBundle,
} from '../src/drive/protocol';
import { acceptedShareRecordFromBundle, projectAcceptedShareViews } from '../src/drive/shareLibrary';

const ownerSecret = new Uint8Array(32).fill(1);
const readerSecret = new Uint8Array(32).fill(2);
const owner = getPublicKey(ownerSecret);
const reader = getPublicKey(readerSecret);
const shareId = '123e4567-e89b-42d3-a456-426614174001';
const ownerId = '123e4567-e89b-42d3-a456-426614174002';
const readerId = '123e4567-e89b-42d3-a456-426614174003';
const key = 'ab'.repeat(32);

function buildNativeInvite() {
  const access = {
    schema: 1, resource_id: shareId, updated_at: 20,
    grants: [
      { target: { type: 'id', id: ownerId }, role: 'admin', status: 'active', display_name: 'Owner' },
      { target: { type: 'id', id: readerId }, role: 'reader', status: 'active', display_name: 'Reader' },
    ],
    devices: {
      [owner]: { pubkey: owner, profile_id: ownerId, added_at: 10 },
      [reader]: { pubkey: reader, profile_id: readerId, added_at: 15 },
    },
    key_epochs: { '1': {
      epoch: 1, created_at: 20, signed_by_pubkey: owner,
      wrapped_secrets: Object.fromEntries([owner, reader].map((pubkey) => [
        pubkey, nip44.v2.encrypt(key, nip44.v2.utils.getConversationKey(ownerSecret, pubkey)),
      ])),
    } },
  };
  const event = finalizeEvent({
    kind: 30078, created_at: 20, content: JSON.stringify(access),
    tags: [['d', shareId], ['l', 'iris-drive/share-access'], ['i', shareId], ['p', owner]],
  }, ownerSecret);
  return {
    schema: 1,
    shared_folder: {
      share_id: shareId, owner_profile_id: ownerId, source_path: 'Photos', display_name: 'Photos',
      local_role: 'admin', access,
    },
    recipient_profile_id: readerId, role: 'reader', created_at: 20,
    access_snapshot: {
      snapshot_id: event.id, signer_pubkey: owner, content: structuredClone(access), event_json: JSON.stringify(event),
    },
  };
}

const nativeTemplate = buildNativeInvite();
function nativeInvite() { return structuredClone(nativeTemplate); }

function encoded(bundle: ReturnType<typeof nativeInvite>): string {
  return encodeShareInvite(bundle as unknown as ShareInviteBundle);
}

function resign(bundle: ReturnType<typeof nativeInvite>, secret = ownerSecret): void {
  const access = bundle.shared_folder.access;
  const event = finalizeEvent({
    kind: 30078, created_at: access.updated_at, content: JSON.stringify(access),
    tags: [['d', shareId], ['l', 'iris-drive/share-access']],
  }, secret);
  bundle.access_snapshot = {
    snapshot_id: event.id, signer_pubkey: event.pubkey, content: structuredClone(access), event_json: JSON.stringify(event),
  };
}


// Native share keys are binary. Authenticate with nostr-tools before reading the
// bytes that its public decrypt API would otherwise decode as UTF-8 text.
function unwrapNativeKey(wrap: string, secret: Uint8Array): Uint8Array {
  const conversationKey = nip44.v2.utils.getConversationKey(secret, owner);
  nip44.v2.decrypt(wrap, conversationKey);
  const payload = Buffer.from(wrap, 'base64');
  const messageKeys = expand(sha256, conversationKey, payload.subarray(1, 33), 76);
  const nonce = Buffer.concat([Buffer.alloc(4), messageKeys.subarray(32, 44)]);
  const cipher = createDecipheriv('chacha20', messageKeys.subarray(0, 32), nonce);
  const padded = Buffer.concat([cipher.update(payload.subarray(33, -32)), cipher.final()]);
  return padded.subarray(2, 2 + padded.readUInt16BE(0));
}

describe('native share access snapshots', () => {
  it('reads a Rust-generated signed invite and decrypts its native NIP-44 key wraps', () => {
    const invite = encodeShareInvite(nativeFixture as ShareInviteBundle);
    const parsed = parseShareInvite(invite);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(nativeFixture);
    expect(encodeShareInvite(parsed)).toBe(invite);
    const folder = sharedFolderFromInviteForProfile(invite, readerId);
    expect(projectSharedFolderView(folder, [], reader)).toMatchObject({
      local_role: 'reader', key_status: 'available', current_key_epoch: 2, can_write: false,
    });
    expect(sharedFolderAuthorizedWriterPubkeys(folder)).toEqual([owner]);
    const wraps = folder.access!.key_epochs!['2'].wrapped_secrets;
    const ownerKey = unwrapNativeKey(wraps[owner], ownerSecret);
    const readerKey = unwrapNativeKey(wraps[reader], readerSecret);
    expect(readerKey).toEqual(ownerKey);
    expect(readerKey).toHaveLength(32);
  });

  it('accepts native invites and projects membership, permissions, and encrypted key availability', () => {
    const bundle = nativeInvite();
    const invite = encoded(bundle);
    const parsed = parseShareInvite(invite);
    const folder = sharedFolderFromInviteForProfile(invite, readerId);
    expect(sharedFolderAuthorizedWriterPubkeys(folder)).toEqual([owner]);
    expect(sharedFolderKeyRecipientPubkeys(folder)).toEqual([owner, reader].sort());
    expect(projectSharedFolderView(folder, [], reader)).toMatchObject({
      local_role: 'reader', can_write: false, can_admin: false, key_status: 'available', participant_count: 2,
    });
    const record = acceptedShareRecordFromBundle(parsed, invite, 25, readerId);
    expect(projectAcceptedShareViews([record])[0]).toMatchObject({
      local_app_key_pubkey: reader, view: { key_status: 'available', local_role: 'reader' },
    });
    expect(nip44.v2.decrypt(bundle.shared_folder.access.key_epochs['1'].wrapped_secrets[reader],
      nip44.v2.utils.getConversationKey(readerSecret, owner))).toBe(key);
    expect(() => sharedFolderFromInviteForProfile(invite, ownerId)).toThrow(/not for NostrIdentity/);
  });

  it.each(['signature', 'folder', 'content', 'id', 'signer', 'coordinate', 'label', 'timestamp'])(
    'rejects tampered %s proof', (field) => {
      const bundle = nativeInvite();
      const event = JSON.parse(bundle.access_snapshot.event_json);
      if (field === 'signature') event.sig = '00'.repeat(64);
      if (field === 'folder') bundle.shared_folder.access.grants[1].role = 'admin';
      if (field === 'content') bundle.access_snapshot.content.grants[1].role = 'admin';
      if (field === 'id') bundle.access_snapshot.snapshot_id = '00'.repeat(32);
      if (field === 'signer') bundle.access_snapshot.signer_pubkey = reader;
      if (field === 'coordinate') event.tags[0][1] = ownerId;
      if (field === 'label') event.tags = [['d', shareId]];
      if (field === 'timestamp') event.created_at = 19;
      bundle.access_snapshot.event_json = JSON.stringify(
        ['coordinate', 'label', 'timestamp'].includes(field) ? finalizeEvent(event, ownerSecret) : event,
      );
      expect(() => parseShareInvite(encoded(bundle))).toThrow();
    },
  );

  it('requires a signed admin snapshot for the native invite format', () => {
    const bundle = nativeInvite();
    resign(bundle, readerSecret);
    expect(() => parseShareInvite(encoded(bundle))).toThrow(/admin/);
    delete (bundle as Partial<typeof bundle>).access_snapshot;
    expect(() => parseShareInvite(encoded(bundle))).toThrow(/snapshot/);
  });

  it('rejects a device map that disagrees with its signed public key', () => {
    const bundle = nativeInvite();
    bundle.shared_folder.access.devices[reader].pubkey = owner;
    resign(bundle);
    expect(() => parseShareInvite(encoded(bundle))).toThrow(/device/);
  });

  it('does not let legacy member fields override native grants', () => {
    const bundle = nativeInvite();
    Object.assign(bundle.shared_folder, { members: { [readerId]: { profile_id: readerId, role: 'admin', status: 'active' } } });
    expect(() => parseShareInvite(encoded(bundle))).toThrow();
  });

  it.each(['recipient_profile_id', 'role', 'created_at', 'source_path', 'display_name', 'local_role'])(
    'rejects malformed required %s fields', (field) => {
      const bundle = nativeInvite();
      const object = field in bundle ? bundle : bundle.shared_folder;
      delete (object as unknown as Record<string, unknown>)[field];
      expect(() => parseShareInvite(encoded(bundle))).toThrow();
    },
  );

  it('preserves current native wire fields when re-encoding a parsed invite', () => {
    const invite = encoded(nativeInvite());
    expect(encodeShareInvite(parseShareInvite(invite))).toBe(invite);
  });

  it('accepts Rust-default empty maps and nullable metadata in equivalent signed fields', () => {
    const bundle = nativeInvite();
    Object.assign(bundle.access_snapshot.content, { tombstones: {} });
    Object.assign(bundle.access_snapshot.content.devices[reader], { label: null });
    expect(() => parseShareInvite(encoded(bundle))).not.toThrow();
  });

  it('honors an active direct-device grant without inventing profile membership', () => {
    const bundle = nativeInvite();
    delete (bundle.shared_folder.access.devices[reader] as { profile_id?: string }).profile_id;
    bundle.shared_folder.access.grants = bundle.shared_folder.access.grants.slice(0, 1);
    (bundle.shared_folder.access.grants as unknown[]).push({
      target: { type: 'pubkey', pubkey: reader }, role: 'editor', status: 'active',
    });
    resign(bundle);
    const folder = parseShareInvite(encoded(bundle)).shared_folder;
    expect(sharedFolderAppKeyWriteAuthorization(folder, reader)).toBe('authorized');
    expect(projectSharedFolderView(folder, [], reader)).toMatchObject({
      can_write: true, can_admin: false, participant_count: 1,
    });
  });

  it('excludes revoked devices even when an active grant remains', () => {
    const bundle = nativeInvite();
    Object.assign(bundle.shared_folder.access, { tombstones: {
      [reader]: { pubkey: reader, profile_id: readerId, removed_by_pubkey: owner, removed_at: 20 },
    } });
    resign(bundle);
    const folder = parseShareInvite(encoded(bundle)).shared_folder;
    expect(sharedFolderKeyRecipientPubkeys(folder)).toEqual([owner]);
    expect(projectSharedFolderView(folder, [], reader)).toMatchObject({ key_status: 'revoked', can_write: false });
  });
});
