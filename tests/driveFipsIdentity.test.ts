import { describe, expect, test, vi } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { toHex } from '@fips/core';
import { signNostrIdentityRosterOp } from '../src/drive/protocol';
import {
  authorizedDriveFipsAppKeyPubkeys,
  createDriveFipsRosterAuthorizationSource,
  resolveDriveFipsIdentity,
} from '../src/lib/driveFipsIdentity';
import { appFacet } from './driveProtocolInterop.helpers';

describe('Drive FIPS identity selection', () => {
  test('uses the active Drive AppKey secret and profile id', () => {
    const secret = new Uint8Array(32);
    secret[31] = 3;
    const pubkey = getPublicKey(secret);
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';

    const resolved = resolveDriveFipsIdentity({
      pubkey,
      nsec: nip19.nsecEncode(secret),
      profileId,
    });

    expect(resolved).toEqual({
      appKeyPubkey: pubkey,
      deviceSecretKey: toHex(secret),
      profileId,
    });
  });

  test('rejects a secret that is not the selected AppKey', () => {
    const selectedSecret = new Uint8Array(32);
    selectedSecret[31] = 4;
    const otherSecret = new Uint8Array(32);
    otherSecret[31] = 5;

    expect(resolveDriveFipsIdentity({
      pubkey: getPublicKey(selectedSecret),
      nsec: nip19.nsecEncode(otherSecret),
      profileId: '89f3d04f-41fb-437b-9339-75df537bf291',
    })).toBeNull();
  });

  test('derives dynamic blob peers from active AppKey facets', () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';
    const admin = generateSecretKey();
    const adminPubkey = getPublicKey(admin);
    const phonePubkey = getPublicKey(generateSecretKey());
    const readerPubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const phone = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 101, 'Phone', true, false),
      },
    });
    const reader = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      parents: [phone.op_id],
      createdAt: 102,
      op: {
        op: 'add_facet',
        facet: appFacet(readerPubkey, 102, 'Reader', false, false),
      },
    });
    const removePhone = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      parents: [reader.op_id],
      createdAt: 103,
      op: { op: 'tombstone_facet', pubkey: phonePubkey },
    });

    expect(authorizedDriveFipsAppKeyPubkeys(profileId, [bootstrap, phone, reader]))
      .toEqual([adminPubkey, phonePubkey, readerPubkey].sort());
    expect(authorizedDriveFipsAppKeyPubkeys(profileId, [bootstrap, phone, reader, removePhone]))
      .toEqual([adminPubkey, readerPubkey].sort());
  });

  test('coalesces fresh roster checks, takes live roster changes at once, and fails closed after expiry', async () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';
    const admin = generateSecretKey();
    const adminPubkey = getPublicKey(admin);
    const phonePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      createdAt: 200,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 200, 'Admin', true, true),
      },
    });
    const phone = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      parents: [bootstrap.op_id],
      createdAt: 201,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 201, 'Phone', true, false),
      },
    });
    const removePhone = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      parents: [phone.op_id],
      createdAt: 202,
      op: { op: 'tombstone_facet', pubkey: phonePubkey },
    });
    let now = 1_000;
    let session = {
      profileId,
      appKeyPubkey: adminPubkey,
      status: 'active' as const,
      rosterOps: [bootstrap, phone],
    };
    const refreshRosterOps = vi.fn(async () => ({ status: 'confirmed' as const, confirmedAt: now, unanswered: [] }));
    const source = createDriveFipsRosterAuthorizationSource({
      identity: { appKeyPubkey: adminPubkey, deviceSecretKey: '00'.repeat(32), profileId },
      getSession: () => session,
      refreshRosterOps,
      now: () => now,
      maxAgeMs: 3_000,
    });

    await expect(Promise.all([source(), source()])).resolves.toEqual([
      [adminPubkey, phonePubkey].sort(),
      [adminPubkey, phonePubkey].sort(),
    ]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(1);

    // The live roster removes the phone: it leaves at once, and the relays are asked behind.
    session = { ...session, rosterOps: [bootstrap, phone, removePhone] };
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(2);
    await flush();

    now += 3_001;
    refreshRosterOps.mockRejectedValueOnce(new Error('relay offline'));
    await expect(source()).resolves.toEqual([]);
  });

  test('keeps answering while relays fail, asks again later and later, and fails closed after expiry', async () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';
    const admin = generateSecretKey();
    const adminPubkey = getPublicKey(admin);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      createdAt: 200,
      op: { op: 'add_facet', facet: appFacet(adminPubkey, 200, 'Admin', true, true) },
    });
    let now = 0;
    const session = { profileId, appKeyPubkey: adminPubkey, status: 'active' as const, rosterOps: [bootstrap] };
    // One relay answered; another did not.
    const refreshRosterOps = vi.fn(async () => ({
      status: 'confirmed' as const,
      confirmedAt: now,
      unanswered: ['wss://slow.example'],
    }));
    const source = createDriveFipsRosterAuthorizationSource({
      identity: { appKeyPubkey: adminPubkey, deviceSecretKey: '00'.repeat(32), profileId },
      getSession: () => session,
      refreshRosterOps,
      now: () => now,
      maxAgeMs: 10_000,
      refreshAfterMs: 4_000,
      failedRetryMs: 1_000,
    });

    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(1);
    await flush();

    // The relay that did not answer is asked again after 1 s, then 2 s.
    now = 999;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(1);
    now = 1_000;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(2);
    await flush();
    now = 2_999;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(2);

    // A failed check keeps the confirmed roster answering, without waiting.
    now = 3_000;
    refreshRosterOps.mockRejectedValueOnce(new Error('relay offline'));
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(3);
    await flush();
    now = 6_999;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(3);

    // Ten minutes, here 10 s, after the last confirmation nobody is admitted.
    now = 11_000;
    refreshRosterOps.mockResolvedValueOnce({ status: 'unconfirmed', confirmedAt: 1_000, unanswered: ['wss://slow.example'] });
    await expect(source()).resolves.toEqual([]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(4);
    await flush();
    now = 11_500;
    await expect(source()).resolves.toEqual([]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(4);
    now = 12_000;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(5);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
