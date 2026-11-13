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

  test('coalesces fresh roster reads, observes live changes, and fails closed after expiry', async () => {
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
    let rosterOps = [bootstrap, phone];
    let session = {
      profileId,
      appKeyPubkey: adminPubkey,
      status: 'active' as const,
      rosterOps,
    };
    const refreshRosterOps = vi.fn(async () => rosterOps);
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

    rosterOps = [bootstrap, phone, removePhone];
    session = { ...session, rosterOps };
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(2);

    now += 3_001;
    refreshRosterOps.mockRejectedValueOnce(new Error('relay offline'));
    await expect(source()).resolves.toEqual([]);
  });

  test('answers from the held roster and checks with the relays in the background once it is old', async () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';
    const admin = generateSecretKey();
    const adminPubkey = getPublicKey(admin);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: admin,
      profileId,
      createdAt: 200,
      op: { op: 'add_facet', facet: appFacet(adminPubkey, 200, 'Admin', true, true) },
    });
    let now = 1_000;
    const session = { profileId, appKeyPubkey: adminPubkey, status: 'active' as const, rosterOps: [bootstrap] };
    let answer: (() => void) | null = null;
    const refreshRosterOps = vi.fn(async () => [bootstrap]);
    const source = createDriveFipsRosterAuthorizationSource({
      identity: { appKeyPubkey: adminPubkey, deviceSecretKey: '00'.repeat(32), profileId },
      getSession: () => session,
      refreshRosterOps,
      now: () => now,
      maxAgeMs: 10_000,
      refreshAfterMs: 4_000,
      failedRetryMs: 2_000,
    });

    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(1);

    // Young: no relay check at all.
    now += 3_000;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(1);

    // Old: answered at once while the relays are asked, which never answer.
    now += 2_000;
    refreshRosterOps.mockImplementationOnce(() => new Promise((_, reject) => {
      answer = () => reject(new Error('relay offline'));
    }));
    await expect(source()).resolves.toEqual([adminPubkey]);
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(2);

    // A failed background check leaves the roster trusted until it expires.
    answer!();
    await Promise.resolve();
    await expect(source()).resolves.toEqual([adminPubkey]);

    now += 6_000;
    refreshRosterOps.mockRejectedValueOnce(new Error('relay offline'));
    await expect(source()).resolves.toEqual([]);
    const failedChecks = refreshRosterOps.mock.calls.length;

    // Failed: stays empty without asking again until the wait is over, then doubles it.
    now += 1_900;
    await expect(source()).resolves.toEqual([]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(failedChecks);
    now += 100;
    refreshRosterOps.mockRejectedValueOnce(new Error('relay offline'));
    await expect(source()).resolves.toEqual([]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(failedChecks + 1);
    now += 3_900;
    await expect(source()).resolves.toEqual([]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(failedChecks + 1);
    now += 100;
    await expect(source()).resolves.toEqual([adminPubkey]);
    expect(refreshRosterOps).toHaveBeenCalledTimes(failedChecks + 2);
  });
});
