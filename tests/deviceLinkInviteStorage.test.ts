import { describe, expect, it } from 'vitest';
import type { DriveDeviceLinkInvite } from '../src/nostr';
import {
  readStoredDeviceLinkInvite,
  saveStoredDeviceLinkInvite,
} from '../src/components/settings/deviceLinkInvites';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('device link invite storage', () => {
  const invite: DriveDeviceLinkInvite = {
    profileId: '019ef2e5-4ab9-79d0-b57f-1d85b21828fd',
    adminAppKeyPubkey: 'a'.repeat(64),
    linkSecretHash: 'secret-hash',
    url: 'https://drive.iris.to/invite/test-payload',
  };

  it('restores the latest invite for the current Drive user admin key', () => {
    const storage = createMemoryStorage();

    saveStoredDeviceLinkInvite(invite, storage, 1_782_303_600_000);

    expect(readStoredDeviceLinkInvite(invite.profileId, invite.adminAppKeyPubkey, storage)).toEqual({
      ...invite,
      createdAt: 1_782_303_600,
    });
  });

  it('does not restore another profile or admin key invite', () => {
    const storage = createMemoryStorage();
    saveStoredDeviceLinkInvite(invite, storage, 1_782_303_600_000);

    expect(readStoredDeviceLinkInvite('different-profile', invite.adminAppKeyPubkey, storage)).toBeNull();
    expect(readStoredDeviceLinkInvite(invite.profileId, 'b'.repeat(64), storage)).toBeNull();
  });
});
