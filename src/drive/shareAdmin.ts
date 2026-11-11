import { finalizeEvent, getPublicKey, nip19, nip44, type Event } from 'nostr-tools';
import type {
  NostrIdentityId,
  ShareAccessGrant,
  ShareAccessSnapshot,
  ShareRecipient,
  ShareRecipientProfileEvidence,
  ShareRole,
  SharedFolder,
  SignedNostrIdentityRosterOp,
} from './protocolTypes';
import { KIND_DRIVE_ROOT } from './protocolTypes';
import { signNostrIdentityFacetAcceptance } from './protocolProfileEvents';
import { projectSharedFolderKeys, snapshotMembers } from './protocolShareSnapshot';
import { sharedFolderAppKeyCanAdmin } from './protocolShareAccess';
import { shareRoleRank } from './protocolShareBase';

/**
 * The changes an admin makes to a shared folder: creating it, adding people,
 * changing a role, removing someone. Each returns a new folder whose access
 * list is ready to be signed with {@link signShareAccessSnapshot}. The format
 * is the one the native apps write and read.
 */

export const SHARE_ACCESS_LABEL = 'iris-drive/share-access';

type Access = Required<Pick<ShareAccessSnapshot, 'grants' | 'devices' | 'tombstones' | 'key_epochs'>> & ShareAccessSnapshot;

export interface ShareOwnerDevice {
  pubkey: string;
  label?: string;
}

export function createSharedFolder(options: {
  signerSecretKey: Uint8Array;
  ownerProfileId: NostrIdentityId;
  /** Every device of the owner that should be able to open the folder. */
  ownerDevices: ShareOwnerDevice[];
  sourcePath: string;
  displayName: string;
  ownerName?: string;
  createdAt: number;
  shareId?: NostrIdentityId;
}): SharedFolder {
  const signerPubkey = getPublicKey(options.signerSecretKey);
  const access: Access = {
    schema: 1,
    resource_id: options.shareId ?? crypto.randomUUID(),
    updated_at: options.createdAt,
    grants: [],
    devices: {},
    tombstones: {},
    key_epochs: {},
  };
  upsertGrant(access, {
    target: { type: 'id', id: options.ownerProfileId },
    role: 'admin',
    status: 'active',
    ...optional('display_name', options.ownerName),
  });
  const devices = options.ownerDevices.some((device) => device.pubkey === signerPubkey)
    ? options.ownerDevices
    : [...options.ownerDevices, { pubkey: signerPubkey }];
  for (const device of devices) {
    upsertDevice(access, device.pubkey, options.ownerProfileId, device.label, options.createdAt);
  }
  const folder: SharedFolder = {
    share_id: access.resource_id,
    owner_profile_id: options.ownerProfileId,
    source_path: options.sourcePath,
    display_name: options.displayName.trim().replace(/[\\/]/g, '_') || 'Shared folder',
    local_role: 'admin',
    access,
    pending_invites: {},
    app_key_roots: {},
  };
  rotateShareKey(folder, options.signerSecretKey, 1, options.createdAt);
  return folder;
}

/** Add the devices of one or more people, or raise the role they already have. */
export function addShareRecipients(
  folder: SharedFolder,
  signerSecretKey: Uint8Array,
  recipients: ShareRecipient[],
  requestedAt: number,
): SharedFolder {
  const next = editableCopy(folder, signerSecretKey);
  const access = next.access as Access;
  if (recipients.length === 0) throw new Error('Nobody to add');
  const members = snapshotMembers(access);
  let time = nextUpdateTime(access, requestedAt);
  for (const recipient of recipients) {
    if (!/^[0-9a-f]{64}$/.test(recipient.app_pubkey)) throw new Error('Invalid device key');
    if (members[recipient.profile_id]?.status === 'revoked') {
      throw new Error('This person was removed from the folder');
    }
    upsertGrant(access, {
      target: { type: 'id', id: recipient.profile_id },
      role: recipient.role,
      status: 'active',
      ...optional('representative_npub_hint', recipient.representative_npub_hint),
      ...optional('display_name', recipient.display_name),
    });
    upsertDevice(access, recipient.app_pubkey, recipient.profile_id, recipient.label, time);
    access.updated_at = Math.max(access.updated_at, time);
    time += 1;
  }
  rotateShareKey(next, signerSecretKey, latestEpoch(access) + 1, nextUpdateTime(access, time));
  return next;
}

export function setShareMemberRole(
  folder: SharedFolder,
  signerSecretKey: Uint8Array,
  profileId: NostrIdentityId,
  role: ShareRole,
  requestedAt: number,
): SharedFolder {
  const next = editableCopy(folder, signerSecretKey);
  const access = next.access as Access;
  const grant = idGrant(access, profileId);
  if (!grant) throw new Error('This person is not in the folder');
  if (grant.status === 'revoked') throw new Error('This person was removed from the folder');
  if (profileId === signerProfileId(next, signerSecretKey)) throw new Error('You cannot change your own role');
  if (grant.role === role) return folder;
  grant.role = role;
  access.updated_at = nextUpdateTime(access, requestedAt);
  return next;
}

/** Remove a person: their devices stop being recipients and the folder key changes. */
export function revokeShareMember(
  folder: SharedFolder,
  signerSecretKey: Uint8Array,
  profileId: NostrIdentityId,
  requestedAt: number,
  reason?: string,
): SharedFolder {
  const next = editableCopy(folder, signerSecretKey);
  const access = next.access as Access;
  const grant = idGrant(access, profileId);
  if (!grant) throw new Error('This person is not in the folder');
  if (profileId === signerProfileId(next, signerSecretKey)) throw new Error('You cannot remove yourself');
  if (grant.status === 'revoked') return folder;
  const signerPubkey = getPublicKey(signerSecretKey);
  const devices = Object.values(access.devices)
    .filter((device) => device.profile_id === profileId && !access.tombstones[device.pubkey])
    .map((device) => device.pubkey)
    .sort();
  grant.status = 'revoked';
  let time = nextUpdateTime(access, requestedAt);
  for (const pubkey of devices) {
    access.tombstones[pubkey] = {
      pubkey,
      profile_id: profileId,
      removed_by_pubkey: signerPubkey,
      removed_at: time,
      ...optional('reason', reason),
    };
    time += 1;
  }
  access.updated_at = Math.max(access.updated_at, time);
  rotateShareKey(next, signerSecretKey, latestEpoch(access) + 1, time);
  return next;
}

/** The signed access list other devices accept as the folder's current membership. */
export function signShareAccessSnapshot(signerSecretKey: Uint8Array, folder: SharedFolder): Event {
  const signerPubkey = getPublicKey(signerSecretKey);
  if (!folder.access || !sharedFolderAppKeyCanAdmin(folder, projectSharedFolderKeys(folder), signerPubkey)) {
    throw new Error('Only an admin can change who has access');
  }
  return finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    content: JSON.stringify(folder.access),
    created_at: folder.access.updated_at,
    tags: [
      ['d', folder.share_id],
      ['l', SHARE_ACCESS_LABEL],
      ['i', folder.share_id],
      ['p', signerPubkey],
    ],
  }, signerSecretKey);
}

/**
 * What a device hands to an admin so it can be added to a folder: its
 * profile's device list and its own signed statement that it belongs to it.
 */
export function recipientEvidenceForAppKey(options: {
  appKeySecretKey: Uint8Array;
  profileId: NostrIdentityId;
  rosterOps: SignedNostrIdentityRosterOp[];
  displayName?: string;
  acceptedAt: number;
}): ShareRecipientProfileEvidence {
  const pubkey = getPublicKey(options.appKeySecretKey);
  const added = options.rosterOps
    .filter((op) => op.content.profile_id === options.profileId
      && op.content.op.op === 'add_facet' && op.content.op.facet.pubkey === pubkey)
    .sort((a, b) => a.content.created_at - b.content.created_at || a.op_id.localeCompare(b.op_id))
    .at(-1);
  return {
    profile_id: options.profileId,
    representative_pubkey: pubkey,
    representative_npub: nip19.npubEncode(pubkey),
    ...optional('display_name', options.displayName?.trim() || undefined),
    roster_ops: options.rosterOps,
    acceptances: [signNostrIdentityFacetAcceptance({
      signerSecretKey: options.appKeySecretKey,
      profileId: options.profileId,
      purposes: ['app_key'],
      rosterOpId: added?.op_id,
      acceptedAt: options.acceptedAt,
    })],
  };
}

function editableCopy(folder: SharedFolder, signerSecretKey: Uint8Array): SharedFolder {
  if (!folder.access) throw new Error('This folder cannot be managed here');
  if (!sharedFolderAppKeyCanAdmin(folder, projectSharedFolderKeys(folder), getPublicKey(signerSecretKey))) {
    throw new Error('Only an admin can change who has access');
  }
  const access = structuredClone(folder.access) as Access;
  access.grants ??= [];
  access.devices ??= {};
  access.tombstones ??= {};
  access.key_epochs ??= {};
  return { ...folder, access };
}

function signerProfileId(folder: SharedFolder, signerSecretKey: Uint8Array): NostrIdentityId | undefined {
  return folder.access?.devices?.[getPublicKey(signerSecretKey)]?.profile_id;
}

function idGrant(access: Access, profileId: NostrIdentityId): ShareAccessGrant | undefined {
  return access.grants.find((grant) => grant.target.type === 'id' && grant.target.id === profileId);
}

function upsertGrant(access: Access, incoming: ShareAccessGrant): void {
  const existing = incoming.target.type === 'id' ? idGrant(access, incoming.target.id) : undefined;
  if (!existing) {
    access.grants.push(incoming);
    return;
  }
  if (shareRoleRank(incoming.role) > shareRoleRank(existing.role)) existing.role = incoming.role;
  if (existing.status === 'pending' && incoming.status === 'active') existing.status = 'active';
  existing.representative_npub_hint ??= incoming.representative_npub_hint;
  existing.display_name ??= incoming.display_name;
}

function upsertDevice(
  access: Access,
  pubkey: string,
  profileId: NostrIdentityId,
  label: string | undefined,
  addedAt: number,
): void {
  const existing = access.devices[pubkey];
  if (existing) {
    existing.profile_id = profileId;
    existing.label ??= label;
    return;
  }
  access.devices[pubkey] = { pubkey, profile_id: profileId, added_at: addedAt, ...optional('label', label) };
}

function latestEpoch(access: Access): number {
  return Math.max(0, ...Object.keys(access.key_epochs).map(Number));
}

function nextUpdateTime(access: ShareAccessSnapshot, requestedAt: number): number {
  return Math.max(requestedAt, access.updated_at + 1);
}

/** Start a key epoch whose key every current recipient device can unwrap. */
function rotateShareKey(folder: SharedFolder, signerSecretKey: Uint8Array, epoch: number, createdAt: number): void {
  const access = folder.access as Access;
  const key = generateShareKey();
  const wrapped: Record<string, string> = {};
  for (const pubkey of Object.keys(projectSharedFolderKeys(folder).active_facets).sort()) {
    wrapped[pubkey] = nip44.v2.encrypt(key, nip44.v2.utils.getConversationKey(signerSecretKey, pubkey));
  }
  access.key_epochs[String(epoch)] = {
    epoch,
    created_at: createdAt,
    signed_by_pubkey: getPublicKey(signerSecretKey),
    wrapped_secrets: wrapped,
  };
  access.updated_at = Math.max(access.updated_at, createdAt);
}

const SHARE_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A share key is 32 bytes. This one is 32 characters of a 64-letter alphabet
 * (192 random bits) so that it is the same 32 bytes as text and as raw data,
 * which is how the native apps unwrap it.
 */
function generateShareKey(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(random, (byte) => SHARE_KEY_ALPHABET[byte & 63]).join('');
}

function optional<K extends string>(name: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [name]: value } as Record<K, string>;
}
