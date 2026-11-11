import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools';
import { encodeShareInvite, parseShareInvite, type ShareInviteBundle } from '../src/drive/protocol';
import { acceptedShareRecordFromBundle, acceptedShares } from '../src/drive/shareLibrary';
import { applyShareAccessEvent } from '../src/drive/shareUpdates';

const ownerSecret = new Uint8Array(32).fill(1);
const readerSecret = new Uint8Array(32).fill(2);
const owner = getPublicKey(ownerSecret);
const reader = getPublicKey(readerSecret);
const shareId = '123e4567-e89b-42d3-a456-426614174001';
const ownerId = '123e4567-e89b-42d3-a456-426614174002';
const readerId = '123e4567-e89b-42d3-a456-426614174003';

function access(updatedAt: number, readerName: string) {
  return {
    schema: 1, resource_id: shareId, updated_at: updatedAt,
    grants: [
      { target: { type: 'id', id: ownerId }, role: 'admin', status: 'active', display_name: 'Owner' },
      { target: { type: 'id', id: readerId }, role: 'reader', status: 'active', display_name: readerName },
    ],
    devices: {
      [owner]: { pubkey: owner, profile_id: ownerId, added_at: 10 },
      [reader]: { pubkey: reader, profile_id: readerId, added_at: 15 },
    },
    key_epochs: { '1': {
      epoch: 1, created_at: 20, signed_by_pubkey: owner,
      wrapped_secrets: Object.fromEntries([owner, reader].map((pubkey) => [
        pubkey, nip44.v2.encrypt('ab'.repeat(32), nip44.v2.utils.getConversationKey(ownerSecret, pubkey)),
      ])),
    } },
  };
}

function accessEvent(updatedAt: number, readerName: string, secret = ownerSecret) {
  return finalizeEvent({
    kind: 30078, created_at: updatedAt, content: JSON.stringify(access(updatedAt, readerName)),
    tags: [['d', shareId], ['l', 'iris-drive/share-access'], ['i', shareId], ['p', owner]],
  }, secret);
}

function acceptedRecord() {
  const event = accessEvent(20, 'Reader');
  const invite = encodeShareInvite({
    schema: 1,
    shared_folder: {
      share_id: shareId, owner_profile_id: ownerId, source_path: 'Photos', display_name: 'Photos',
      local_role: 'admin', access: JSON.parse(event.content),
    },
    recipient_profile_id: readerId, role: 'reader', created_at: 20,
    access_snapshot: {
      snapshot_id: event.id, signer_pubkey: owner, content: JSON.parse(event.content),
      event_json: JSON.stringify(event),
    },
  } as unknown as ShareInviteBundle);
  return acceptedShareRecordFromBundle(parseShareInvite(invite), invite, 25, readerId);
}

describe('share access updates', () => {
  let notifications: number;

  beforeEach(() => {
    acceptedShares.set([acceptedRecord()]);
    notifications = 0;
    const unsubscribe = acceptedShares.subscribe(() => { notifications += 1; });
    notifications = 0;
    return unsubscribe;
  });

  it('applies a newer signed update once and ignores its replays without notifying', () => {
    const update = accessEvent(30, 'Renamed reader');

    expect(applyShareAccessEvent(shareId, update)).toBe(true);
    expect(notifications).toBe(1);
    expect(get(acceptedShares)[0].folder.access?.updated_at).toBe(30);

    // The periodic backfill returns the same event again, and older ones.
    expect(applyShareAccessEvent(shareId, update)).toBe(true);
    expect(applyShareAccessEvent(shareId, accessEvent(20, 'Reader'))).toBe(true);
    expect(notifications).toBe(1);
  });

  it('ignores a newer update signed by someone without admin access', () => {
    expect(applyShareAccessEvent(shareId, accessEvent(40, 'Hijacked', readerSecret))).toBe(true);
    expect(notifications).toBe(0);
    expect(get(acceptedShares)[0].folder.access?.updated_at).toBe(20);
  });

  it('leaves events that are not access updates to the caller', () => {
    const other = finalizeEvent({ kind: 30078, created_at: 50, content: '', tags: [['d', shareId]] }, ownerSecret);
    expect(applyShareAccessEvent(shareId, other)).toBe(false);
    expect(notifications).toBe(0);
  });
});
