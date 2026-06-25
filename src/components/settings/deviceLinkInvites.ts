import type { DriveDeviceLinkInvite } from '../../nostr';

const STORAGE_KEY = 'iris:drive:device-link-invites';

export type StoredDeviceLinkInvite = DriveDeviceLinkInvite & {
  createdAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageAvailable(storage: StorageLike | null | undefined): storage is StorageLike {
  return Boolean(storage);
}

function storageKey(profileId: string, adminAppKeyPubkey: string): string {
  return `${profileId}:${adminAppKeyPubkey}`;
}

function readAll(storage: StorageLike): Record<string, StoredDeviceLinkInvite> {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, StoredDeviceLinkInvite>
      : {};
  } catch {
    return {};
  }
}

export function readStoredDeviceLinkInvite(
  profileId: string,
  adminAppKeyPubkey: string,
  storage: StorageLike | null | undefined = typeof localStorage === 'undefined' ? null : localStorage,
): StoredDeviceLinkInvite | null {
  if (!storageAvailable(storage)) return null;
  const stored = readAll(storage)[storageKey(profileId, adminAppKeyPubkey)];
  if (
    !stored
    || stored.profileId !== profileId
    || stored.adminAppKeyPubkey !== adminAppKeyPubkey
    || typeof stored.invitePubkey !== 'string'
    || typeof stored.inviteSecretKeyNsec !== 'string'
    || typeof stored.url !== 'string'
  ) {
    return null;
  }
  return stored;
}

export function saveStoredDeviceLinkInvite(
  invite: DriveDeviceLinkInvite,
  storage: StorageLike | null | undefined = typeof localStorage === 'undefined' ? null : localStorage,
  nowMs = Date.now(),
): void {
  if (!storageAvailable(storage)) return;
  const all = readAll(storage);
  all[storageKey(invite.profileId, invite.adminAppKeyPubkey)] = {
    ...invite,
    createdAt: Math.floor(nowMs / 1000),
  };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    storage.removeItem(STORAGE_KEY);
  }
}
