import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';
import {
  encodeShareInvite,
  parseShareInvite,
  projectSharedFolderView,
  sharedFolderAuthorizedWriterPubkeys,
  sharedFolderKeyRecipientPubkeys,
  signNostrIdentityRosterOp,
  type ShareInviteBundle,
  type SharedFolder,
} from '../src/drive/protocol';
import {
  addShareRecipients,
  createSharedFolder,
  recipientEvidenceForAppKey,
  revokeShareMember,
  setShareMemberRole,
  signShareAccessSnapshot,
} from '../src/drive/shareAdmin';
import {
  buildShareJoinRequest,
  encodeShareJoinLink,
  folderFromAccessEventForJoin,
  joinRequestNeedsApproval,
  parseShareJoinLink,
  shareJoinLinkPubkey,
  shareRecipientsFromJoinRequest,
  type ShareJoinLink,
} from '../src/drive/shareJoinLink';
import { validateShareAccessUpdate } from '../src/drive/protocolShareSnapshotValidation';

const ownerSecret = generateSecretKey();
const owner = getPublicKey(ownerSecret);
const ownerProfile = '123e4567-e89b-42d3-a456-426614174201';
const guestProfile = '123e4567-e89b-42d3-a456-426614174202';
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function profileDevice(profileId: string, secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret);
  const rosterOps = [signNostrIdentityRosterOp({
    signerSecretKey: secret,
    profileId,
    createdAt: 5,
    op: {
      op: 'add_facet',
      facet: {
        pubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true, can_admin_profile: true,
          can_receive_secret_wraps: true, can_decrypt_secret_epochs: true,
        },
        added_at: 5,
      },
    },
  })];
  return { secret, pubkey, rosterOps };
}

function newFolder(): SharedFolder {
  return createSharedFolder({
    signerSecretKey: ownerSecret,
    ownerProfileId: ownerProfile,
    ownerDevices: [{ pubkey: owner, label: 'Laptop' }],
    sourcePath: 'Projects/Plan',
    displayName: 'Plan',
    ownerName: 'Owner',
    createdAt: 100,
  });
}

function joinLink(folder: SharedFolder, role: 'editor' | 'reader' = 'editor'): ShareJoinLink {
  return {
    v: 1, share_id: folder.share_id, owner_profile_id: ownerProfile, admin: owner,
    name: folder.display_name, role, key: hex(generateSecretKey()),
  };
}

function unwrap(folder: SharedFolder, secret: Uint8Array): string {
  const epochs = Object.values(folder.access!.key_epochs!).sort((a, b) => b.epoch - a.epoch);
  const wrap = epochs[0]!.wrapped_secrets[getPublicKey(secret)]!;
  return nip44.v2.decrypt(wrap, nip44.v2.utils.getConversationKey(secret, epochs[0]!.signed_by_pubkey));
}

describe('creating a shared folder', () => {
  it('makes the owner the only admin and gives every owner device the key', () => {
    const second = generateSecretKey();
    const folder = createSharedFolder({
      signerSecretKey: ownerSecret, ownerProfileId: ownerProfile,
      ownerDevices: [{ pubkey: owner }, { pubkey: getPublicKey(second) }],
      sourcePath: 'Plan', displayName: 'Plan', createdAt: 100,
    });
    const view = projectSharedFolderView(folder, [], owner);
    expect(view.can_admin).toBe(true);
    expect(view.key_status).toBe('available');
    expect(view.members.map((member) => [member.profile_id, member.role])).toEqual([[ownerProfile, 'admin']]);
    expect(sharedFolderKeyRecipientPubkeys(folder)).toEqual([owner, getPublicKey(second)].sort());
    expect(unwrap(folder, second)).toBe(unwrap(folder, ownerSecret));
  });

  it('wraps a key that is exactly 32 bytes, as the native apps require', () => {
    expect(new TextEncoder().encode(unwrap(newFolder(), ownerSecret))).toHaveLength(32);
  });

  it('signs an access list that passes the same checks as an invite from the native app', () => {
    const guest = profileDevice(guestProfile);
    const folder = addShareRecipients(newFolder(), ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor', display_name: 'Guest',
    }], 110);
    const event = signShareAccessSnapshot(ownerSecret, folder);
    const bundle: ShareInviteBundle = {
      schema: 1,
      shared_folder: folder,
      recipient_profile_id: guestProfile,
      role: 'editor',
      access_snapshot: {
        snapshot_id: event.id, signer_pubkey: event.pubkey,
        content: JSON.parse(event.content), event_json: JSON.stringify(event),
      },
      created_at: 110,
    };
    expect(parseShareInvite(encodeShareInvite(bundle)).shared_folder.share_id).toBe(folder.share_id);
  });
});

describe('changing who has access', () => {
  it('adds an editor who can write and unwrap the new key, and moves time forward', () => {
    const guest = profileDevice(guestProfile);
    const before = newFolder();
    const after = addShareRecipients(before, ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor', display_name: 'Guest',
    }], 50);
    expect(after.access!.updated_at).toBeGreaterThan(before.access!.updated_at);
    expect(sharedFolderAuthorizedWriterPubkeys(after)).toEqual([owner, guest.pubkey].sort());
    expect(unwrap(after, guest.secret)).toBe(unwrap(after, ownerSecret));
    expect(unwrap(after, ownerSecret)).not.toBe(unwrap(before, ownerSecret));
    // A device that already holds the folder accepts the signed update.
    expect(validateShareAccessUpdate(before, signShareAccessSnapshot(ownerSecret, after)).updated_at)
      .toBe(after.access!.updated_at);
    expect(before.access!.grants).toHaveLength(1);
  });

  it('lets a reader read but not write, and a role change takes effect', () => {
    const guest = profileDevice(guestProfile);
    const reader = addShareRecipients(newFolder(), ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'reader',
    }], 110);
    expect(sharedFolderAuthorizedWriterPubkeys(reader)).toEqual([owner]);
    expect(sharedFolderKeyRecipientPubkeys(reader)).toContain(guest.pubkey);
    const editor = setShareMemberRole(reader, ownerSecret, guestProfile, 'editor', 120);
    expect(sharedFolderAuthorizedWriterPubkeys(editor)).toContain(guest.pubkey);
    expect(editor.access!.updated_at).toBeGreaterThan(reader.access!.updated_at);
  });

  it('removes a person: no writing, no new key, and they cannot be added back by a link', () => {
    const guest = profileDevice(guestProfile);
    const joined = addShareRecipients(newFolder(), ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor',
    }], 110);
    const removed = revokeShareMember(joined, ownerSecret, guestProfile, 120);
    expect(sharedFolderAuthorizedWriterPubkeys(removed)).toEqual([owner]);
    expect(sharedFolderKeyRecipientPubkeys(removed)).toEqual([owner]);
    const latest = Object.values(removed.access!.key_epochs!).sort((a, b) => b.epoch - a.epoch)[0]!;
    expect(Object.keys(latest.wrapped_secrets)).toEqual([owner]);
    expect(projectSharedFolderView(removed, [], guest.pubkey).key_status).toBe('revoked');
    expect(() => addShareRecipients(removed, ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor',
    }], 130)).toThrow('removed');
    expect(joinRequestNeedsApproval(removed, guestProfile, guest.pubkey)).toBe(false);
  });

  it('refuses changes from someone who is not an admin, and changes to oneself', () => {
    const guest = profileDevice(guestProfile);
    const folder = addShareRecipients(newFolder(), ownerSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor',
    }], 110);
    expect(() => setShareMemberRole(folder, guest.secret, ownerProfile, 'reader', 120)).toThrow('admin');
    expect(() => signShareAccessSnapshot(guest.secret, folder)).toThrow('admin');
    expect(() => revokeShareMember(folder, ownerSecret, ownerProfile, 120)).toThrow('yourself');
  });
});

describe('joining by link', () => {
  it('round-trips a link and rejects a damaged one', () => {
    const link = { ...joinLink(newFolder()), doc: 'Plan.irisdoc' };
    const url = encodeShareJoinLink(link, 'https://drive.example/');
    expect(url.startsWith('https://drive.example/#/share-join/')).toBe(true);
    expect(parseShareJoinLink(url)).toEqual(link);
    expect(() => parseShareJoinLink(encodeShareJoinLink({ ...link, role: 'admin' as 'editor' }, 'https://x'))).toThrow();
  });

  it('takes a visitor from request to an editable folder', () => {
    const guest = profileDevice(guestProfile);
    const folder = newFolder();
    const link = joinLink(folder);
    const request = buildShareJoinRequest(link, recipientEvidenceForAppKey({
      appKeySecretKey: guest.secret, profileId: guestProfile, rosterOps: guest.rosterOps,
      displayName: 'Guest', acceptedAt: 105,
    }), 105);
    expect(request.pubkey).toBe(shareJoinLinkPubkey(link));

    const { recipients, profileId, requester } = shareRecipientsFromJoinRequest(link, request);
    expect(recipients).toMatchObject([{ profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor' }]);
    expect(joinRequestNeedsApproval(folder, profileId, requester)).toBe(true);

    const approved = addShareRecipients(folder, ownerSecret, recipients, 110);
    expect(joinRequestNeedsApproval(approved, profileId, requester)).toBe(false);
    const access = signShareAccessSnapshot(ownerSecret, approved);

    expect(folderFromAccessEventForJoin(link, signShareAccessSnapshot(ownerSecret, folder), guest.pubkey)).toBeNull();
    const joined = folderFromAccessEventForJoin(link, access, guest.pubkey)!;
    expect(joined.local_role).toBe('editor');
    expect(projectSharedFolderView(joined, [], guest.pubkey).can_write).toBe(true);
  });

  it('ignores a request that was not signed with the link', () => {
    const guest = profileDevice(guestProfile);
    const folder = newFolder();
    const link = joinLink(folder);
    const evidence = recipientEvidenceForAppKey({
      appKeySecretKey: guest.secret, profileId: guestProfile, rosterOps: guest.rosterOps, acceptedAt: 105,
    });
    const forged = buildShareJoinRequest({ ...link, key: hex(generateSecretKey()) }, evidence, 105);
    expect(() => shareRecipientsFromJoinRequest(link, forged)).toThrow('this link');
  });

  it('ignores a request that names a device the profile never accepted', () => {
    const guest = profileDevice(guestProfile);
    const intruder = generateSecretKey();
    const folder = newFolder();
    const link = joinLink(folder);
    const evidence = recipientEvidenceForAppKey({
      appKeySecretKey: guest.secret, profileId: guestProfile, rosterOps: guest.rosterOps, acceptedAt: 105,
    });
    const request = buildShareJoinRequest(link, { ...evidence, representative_pubkey: getPublicKey(intruder) }, 105);
    expect(() => shareRecipientsFromJoinRequest(link, request)).toThrow();
  });

  it('does not accept an access list signed by anyone but the admin in the link', () => {
    const guest = profileDevice(guestProfile);
    const folder = newFolder();
    const link = joinLink(folder);
    const impostorSecret = generateSecretKey();
    const impostor = createSharedFolder({
      signerSecretKey: impostorSecret, ownerProfileId: ownerProfile,
      ownerDevices: [{ pubkey: getPublicKey(impostorSecret) }],
      sourcePath: 'Plan', displayName: 'Plan', createdAt: 100, shareId: folder.share_id,
    });
    const withGuest = addShareRecipients(impostor, impostorSecret, [{
      profile_id: guestProfile, app_pubkey: guest.pubkey, role: 'editor',
    }], 110);
    expect(folderFromAccessEventForJoin(link, signShareAccessSnapshot(impostorSecret, withGuest), guest.pubkey)).toBeNull();
    // An unrelated event from the right key is not an access list either.
    const junk = finalizeEvent({ kind: 30078, created_at: 1, content: '{}', tags: [['d', folder.share_id]] }, ownerSecret);
    expect(folderFromAccessEventForJoin(link, junk, guest.pubkey)).toBeNull();
  });
});
