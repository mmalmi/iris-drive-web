/**
 * Who may take part in a document's live channel, who each device belongs
 * to, and the secret the channel's key is made from: only people who can
 * already read the document.
 *
 * - In a shared folder, the folder's current key epoch, which every member's
 *   device can unwrap. Removing someone starts a new epoch they cannot. The
 *   devices are the folder's admin-signed access list, and each is named by
 *   the person it belongs to there.
 * - In a Drive's own folders, the Drive's current content key, which only the
 *   account's devices can unwrap. The devices are the account's roster.
 * - In an account without a Drive profile, the account's own secret key.
 *
 * The epoch before the current one is listened to as well, so that people
 * whose devices have not seen a new epoch yet are still heard; nothing is
 * sent with it, and what comes on it counts only from current devices.
 */
import { getPublicKey, nip19, nip44 } from 'nostr-tools';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { fallbackIdentityName } from '@iris/svelte-ui/profile';
import { projectNostrIdentityRoster } from '../../drive/protocolProfileProjection';
import { projectSharedFolderKeys } from '../../drive/protocolShareSnapshot';
import { sharedFolderAuthorizedWriterPubkeys } from '../../drive/protocolShareAccess';
import { shareParticipantProfiles } from '../../drive/protocolShareBase';
import { sharedFolderKeyRecipientPubkeys } from '../../drive/protocolShareRecipients';
import { projectSharedFolderView } from '../../drive/protocolShareView';
import { memberNpub } from '../../drive/people';
import type { NostrIdentitySecretEpoch, SharedFolder, SignedNostrIdentityRosterOp } from '../../drive/protocolTypes';
import { secretId, type LiveSecretKind } from './liveKeys';

export interface LiveSecret {
  id: string;
  secret: Uint8Array;
}

/** A device that may take part, and the person it belongs to. */
export interface LiveDevice {
  /** The person: a Drive profile id, else the device's key. */
  id: string;
  /** The person's name as the access list or the account gives it. */
  name: string;
  npub: string | null;
  /** Whether its edits are taken. */
  canEdit: boolean;
}

export interface LiveAccess {
  kind: LiveSecretKind;
  /** The current secret, then the one before it. */
  secrets: LiveSecret[];
  /** Every device that may read the document, by its key. */
  devices: ReadonlyMap<string, LiveDevice>;
}

/** The name and npub of the account this device is signed in to. */
export interface OwnAccount {
  name: string;
  npub: string | null;
}

const unwrapped = new Map<string, Uint8Array | null>();

function unwrap(epoch: NostrIdentitySecretEpoch, deviceKey: string, deviceSecretKey: Uint8Array): Uint8Array | null {
  const wrapped = epoch.wrapped_secrets?.[deviceKey];
  if (!wrapped) return null;
  const cacheKey = `${deviceKey}:${epoch.signed_by_pubkey}:${wrapped}`;
  if (!unwrapped.has(cacheKey)) {
    let secret: Uint8Array | null = null;
    try {
      secret = utf8ToBytes(nip44.v2.decrypt(wrapped, nip44.v2.utils.getConversationKey(deviceSecretKey, epoch.signed_by_pubkey)));
    } catch {
      secret = null;
    }
    unwrapped.set(cacheKey, secret);
  }
  return unwrapped.get(cacheKey) ?? null;
}

/** The newest epoch's secret and the one before it; null when this device cannot open the newest. */
function epochSecrets(
  kind: LiveSecretKind,
  epochs: Record<string, NostrIdentitySecretEpoch> | undefined,
  deviceKey: string,
  deviceSecretKey: Uint8Array,
): LiveSecret[] | null {
  const [current, previous] = Object.values(epochs ?? {}).sort((left, right) => right.epoch - left.epoch);
  if (!current) return null;
  const secret = unwrap(current, deviceKey, deviceSecretKey);
  if (!secret) return null;
  const secrets = [{ id: secretId(kind, current.epoch, secret), secret }];
  const earlier = previous ? unwrap(previous, deviceKey, deviceSecretKey) : null;
  if (previous && earlier) secrets.push({ id: secretId(kind, previous.epoch, earlier), secret: earlier });
  return secrets;
}

function npubOf(pubkey: string): string | null {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return null;
  }
}

export function shareLiveAccess(folder: SharedFolder, deviceKey: string, deviceSecretKey: Uint8Array): LiveAccess | null {
  const projection = projectSharedFolderKeys(folder);
  const secrets = epochSecrets('share', projection.secret_epochs, deviceKey, deviceSecretKey);
  if (!secrets) return null;
  const profiles = shareParticipantProfiles(projection);
  const names = new Map(projectSharedFolderView(folder, [], deviceKey).members.map(member => [member.profile_id, member.display_name]));
  const writers = new Set(sharedFolderAuthorizedWriterPubkeys(folder));
  const devices = new Map<string, LiveDevice>();
  for (const key of sharedFolderKeyRecipientPubkeys(folder)) {
    const profileId = profiles[key];
    devices.set(key, {
      id: profileId ?? key,
      name: (profileId && names.get(profileId)) || fallbackIdentityName(profileId ?? key),
      npub: profileId ? memberNpub(folder, profileId) : npubOf(key),
      canEdit: writers.has(key),
    });
  }
  return { kind: 'share', secrets, devices };
}

export function driveLiveAccess(
  profileId: string,
  rosterOps: SignedNostrIdentityRosterOp[],
  deviceKey: string,
  deviceSecretKey: Uint8Array,
  own: OwnAccount,
): LiveAccess | null {
  const projection = projectNostrIdentityRoster(profileId, rosterOps);
  const secrets = epochSecrets('drive', projection.secret_epochs, deviceKey, deviceSecretKey);
  if (!secrets) return null;
  const devices = new Map<string, LiveDevice>();
  for (const key of Object.keys(projection.active_facets)) devices.set(key, { id: profileId, ...own, canEdit: true });
  return { kind: 'drive', secrets, devices };
}

export function accountLiveAccess(deviceSecretKey: Uint8Array, own: OwnAccount): LiveAccess {
  const key = getPublicKey(deviceSecretKey);
  return {
    kind: 'account',
    secrets: [{ id: secretId('account', 0, deviceSecretKey), secret: deviceSecretKey }],
    devices: new Map([[key, { id: key, ...own, canEdit: true }]]),
  };
}
