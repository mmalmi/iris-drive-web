import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import {
  parseNostrIdentityRosterOpEvent,
  signNostrIdentityRosterOp,
  type SignedNostrIdentityRosterOp,
} from '../src/drive/protocol';
import {
  DriveRosterLiveCandidateBuffer,
  driveApprovalRosterIsReadyForAppKey,
  fetchAuthoritativeDriveRoster,
  projectAnchoredDriveRoster,
  projectDriveRosterFromApprovalReceipt,
  rosterAuthorFilter,
} from '../src/nostr/driveRosterRefresh';
import {
  publishDriveRosterHistory,
  publishDriveRosterThenActivate,
} from '../src/nostr/driveRosterPublish';
import { appFacet } from './driveProtocolInterop.helpers';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';

describe('authoritative Drive roster refresh', () => {
  it('rejects a correctly signed private mutation from a revoked key with complete current parents', () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const deviceSecret = generateSecretKey();
    const devicePubkey = getPublicKey(deviceSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret, profileId: PROFILE_ID, createdAt: 100,
      op: { op: 'add_facet', facet: appFacet(ownerPubkey, 100, 'Owner', true, true) },
    });
    const addDevice = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret, profileId: PROFILE_ID, createdAt: 101,
      parents: [bootstrap.op_id],
      op: { op: 'add_facet', facet: appFacet(devicePubkey, 101, 'Device', true, true) },
    });
    const removeDevice = signNostrIdentityRosterOp({
      signerSecretKey: ownerSecret, profileId: PROFILE_ID, createdAt: 102,
      parents: [bootstrap.op_id, addDevice.op_id],
      op: { op: 'tombstone_facet', pubkey: devicePubkey },
    });
    const baseline = [bootstrap, addDevice, removeDevice];
    const mutation = {
      profileId: PROFILE_ID, createdAt: 103,
      parents: baseline.map((op) => op.op_id),
      op: {
        op: 'set_capabilities' as const,
        pubkey: ownerPubkey,
        capabilities: { can_admin_profile: true, can_write_roots: false },
      },
    };
    const candidate = signNostrIdentityRosterOp({ ...mutation, signerSecretKey: deviceSecret });
    expect(verifyEvent(JSON.parse(candidate.event_json))).toBe(true);
    const rejected = new DriveRosterLiveCandidateBuffer().replay(PROFILE_ID, baseline, candidate);
    expect(rejected.projection.accepted_op_ids).not.toContain(candidate.op_id);
    expect(rejected.projection.active_facets[ownerPubkey].capabilities?.can_write_roots).toBe(true);

    const control = signNostrIdentityRosterOp({ ...mutation, signerSecretKey: ownerSecret });
    const accepted = new DriveRosterLiveCandidateBuffer().replay(PROFILE_ID, baseline, control);
    expect(accepted.projection.accepted_op_ids).toContain(control.op_id);
    expect(Boolean(accepted.projection.active_facets[ownerPubkey].capabilities?.can_write_roots)).toBe(false);
  });

  it('replays a live DCK rotation that arrives before its add-facet parent', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const addPhone = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 101, 'Phone', true, false),
      },
    });
    const rotation = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addPhone.op_id],
      createdAt: 102,
      op: {
        op: 'rotate_secret_epoch',
        epoch: 2,
        wrapped_secrets: { [phonePubkey]: 'wrapped-for-phone' },
      },
    });
    const buffer = new DriveRosterLiveCandidateBuffer();

    const waiting = buffer.replay(PROFILE_ID, [bootstrap], rotation);
    expect(waiting.rosterOps.map((op) => op.op_id)).toEqual([bootstrap.op_id]);
    expect(buffer.pendingCount).toBe(1);

    const replayed = buffer.replay(PROFILE_ID, [bootstrap], addPhone);
    expect(replayed.rosterOps.map((op) => op.op_id)).toEqual([
      bootstrap.op_id,
      addPhone.op_id,
      rotation.op_id,
    ]);
    expect(replayed.projection.secret_epochs['2']?.wrapped_secrets[phonePubkey])
      .toBe('wrapped-for-phone');
    expect(buffer.pendingCount).toBe(0);
  });

  it('anchors approval activation to the receipt parent chain instead of a backdated attacker bootstrap', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const attackerSecret = generateSecretKey();
    const attackerPubkey = getPublicKey(attackerSecret);
    const devicePubkey = getPublicKey(generateSecretKey());
    const attackerBootstrap = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      createdAt: 1,
      op: {
        op: 'add_facet',
        facet: appFacet(attackerPubkey, 1, 'Attacker', true, true),
      },
    });
    const attackerAddsDevice = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      parents: [attackerBootstrap.op_id],
      createdAt: 2,
      op: {
        op: 'add_facet',
        facet: appFacet(devicePubkey, 2, 'Observed device', true, false),
      },
    });
    const attackerEpoch = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      parents: [attackerBootstrap.op_id, attackerAddsDevice.op_id],
      createdAt: 3,
      op: {
        op: 'rotate_secret_epoch',
        epoch: 99,
        wrapped_secrets: { [devicePubkey]: 'attacker-wrap' },
      },
    });
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const receiptRosterOp = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(devicePubkey, 101, 'Approved device', true, false),
      },
    });
    const legitimateEpoch = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, receiptRosterOp.op_id],
      createdAt: 102,
      op: {
        op: 'rotate_secret_epoch',
        epoch: 1,
        wrapped_secrets: { [devicePubkey]: 'legitimate-wrap' },
      },
    });

    const anchored = projectDriveRosterFromApprovalReceipt(
      PROFILE_ID,
      receiptRosterOp,
      [
        attackerBootstrap,
        attackerAddsDevice,
        attackerEpoch,
        bootstrap,
        legitimateEpoch,
      ],
    );

    expect(anchored.projection.accepted_op_ids).toContain(receiptRosterOp.op_id);
    expect(anchored.rosterOps.map((op) => op.op_id)).toEqual([
      bootstrap.op_id,
      receiptRosterOp.op_id,
      legitimateEpoch.op_id,
    ]);
    expect(anchored.projection.active_facets).not.toHaveProperty(attackerPubkey);
    expect(anchored.projection.secret_epochs['99']).toBeUndefined();
    expect(anchored.projection.secret_epochs['1']?.wrapped_secrets[devicePubkey])
      .toBe('legitimate-wrap');
    expect(driveApprovalRosterIsReadyForAppKey(
      anchored,
      receiptRosterOp.op_id,
      devicePubkey,
    )).toBe(true);

    const withoutAuthorizedDck = projectDriveRosterFromApprovalReceipt(
      PROFILE_ID,
      receiptRosterOp,
      [attackerBootstrap, attackerAddsDevice, attackerEpoch, bootstrap],
    );
    expect(driveApprovalRosterIsReadyForAppKey(
      withoutAuthorizedDck,
      receiptRosterOp.op_id,
      devicePubkey,
    )).toBe(false);
  });

  it('rejects an incomplete or unauthorized approval receipt parent chain', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const attackerSecret = generateSecretKey();
    const devicePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const legitimateReceiptOp = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(devicePubkey, 101, 'Device', true, false),
      },
    });
    const unauthorizedReceiptOp = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(devicePubkey, 101, 'Device', true, false),
      },
    });

    expect(() => projectDriveRosterFromApprovalReceipt(
      PROFILE_ID,
      legitimateReceiptOp,
      [],
    )).toThrow('parent chain is incomplete');
    expect(() => projectDriveRosterFromApprovalReceipt(
      PROFILE_ID,
      unauthorizedReceiptOp,
      [bootstrap],
    )).toThrow('not authorized by its parent chain');
  });

  it('keeps the trusted bootstrap when a backdated attacker self-bootstraps the known profile id', () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const attackerSecret = generateSecretKey();
    const attackerPubkey = getPublicKey(attackerSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const backdatedTakeover = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      createdAt: 1,
      op: {
        op: 'add_facet',
        facet: appFacet(attackerPubkey, 1, 'Attacker', true, true),
      },
    });

    const anchored = projectAnchoredDriveRoster(PROFILE_ID, [bootstrap], [backdatedTakeover]);

    expect(anchored.rosterOps.map((op) => op.op_id)).toEqual([bootstrap.op_id]);
    expect(anchored.projection.active_facets).toHaveProperty(adminPubkey);
    expect(anchored.projection.active_facets).not.toHaveProperty(attackerPubkey);
  });

  it('rejects a post-revocation backdated fork that omits the trusted baseline', () => {
    const firstAdminSecret = generateSecretKey();
    const firstAdminPubkey = getPublicKey(firstAdminSecret);
    const currentAdminSecret = generateSecretKey();
    const currentAdminPubkey = getPublicKey(currentAdminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(firstAdminPubkey, 100, 'First admin', true, true),
      },
    });
    const addCurrentAdmin = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(currentAdminPubkey, 101, 'Current admin', true, true),
      },
    });
    const revokeFirstAdmin = signNostrIdentityRosterOp({
      signerSecretKey: currentAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addCurrentAdmin.op_id],
      createdAt: 103,
      op: { op: 'tombstone_facet', pubkey: firstAdminPubkey },
    });
    const backdatedTombstoneCurrentAdmin = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      // Deliberately forks before and omits the already-trusted revocation.
      parents: [bootstrap.op_id, addCurrentAdmin.op_id],
      createdAt: 102,
      op: { op: 'tombstone_facet', pubkey: currentAdminPubkey },
    });
    const forkedReAdd = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addCurrentAdmin.op_id, backdatedTombstoneCurrentAdmin.op_id],
      createdAt: 104,
      op: {
        op: 'add_facet',
        facet: appFacet(firstAdminPubkey, 104, 'First admin again', true, true),
      },
    });

    const anchored = projectAnchoredDriveRoster(
      PROFILE_ID,
      [bootstrap, addCurrentAdmin, revokeFirstAdmin],
      [backdatedTombstoneCurrentAdmin, forkedReAdd],
    );

    expect(anchored.rosterOps.map((op) => op.op_id)).toEqual([
      bootstrap.op_id,
      addCurrentAdmin.op_id,
      revokeFirstAdmin.op_id,
    ]);
    expect(anchored.projection.active_facets).not.toHaveProperty(firstAdminPubkey);
    expect(anchored.projection.active_facets).toHaveProperty(currentAdminPubkey);
  });

  it('publishes a newly created profile history before its first authoritative refresh', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const initialDck = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'rotate_secret_epoch',
        epoch: 1,
        wrapped_secrets: { [adminPubkey]: 'wrapped' },
      },
    });
    const published: SignedNostrIdentityRosterOp[] = [];

    await publishDriveRosterHistory([bootstrap, initialDck], async (eventJson) => {
      published.push(parseNostrIdentityRosterOpEvent(JSON.parse(eventJson)));
    });
    const refreshed = await fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap, initialDck],
      fetchAuthors: async () => ({ complete: true, rosterOps: published }),
    });

    expect(published.map((op) => op.op_id)).toEqual([bootstrap.op_id, initialDck.op_id]);
    expect(refreshed.rosterOps.map((op) => op.op_id)).toEqual([bootstrap.op_id, initialDck.op_id]);
    expect(refreshed.projection.secret_epochs).toHaveProperty('1');
  });

  it('does not activate a newly created profile when baseline publication fails', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const activate = vi.fn(async () => 'active');

    await expect(publishDriveRosterThenActivate(
      [bootstrap],
      async () => {
        throw new Error('relay unavailable');
      },
      activate,
    )).rejects.toThrow('relay unavailable');

    expect(activate).not.toHaveBeenCalled();
  });

  it('queries only trusted authority authors and follows a newly granted admin iteratively', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const secondAdminSecret = generateSecretKey();
    const secondAdminPubkey = getPublicKey(secondAdminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const addSecondAdmin = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(secondAdminPubkey, 101, 'Second admin', true, true),
      },
    });
    const addPhone = signNostrIdentityRosterOp({
      signerSecretKey: secondAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addSecondAdmin.op_id],
      createdAt: 102,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 102, 'Phone', true, false),
      },
    });
    const attackerSecret = generateSecretKey();
    const attackerPubkey = getPublicKey(attackerSecret);
    const spam = signNostrIdentityRosterOp({
      signerSecretKey: attackerSecret,
      profileId: PROFILE_ID,
      createdAt: 1,
      op: {
        op: 'add_facet',
        facet: appFacet(attackerPubkey, 1, 'Spam', true, true),
      },
    });
    const fetchAuthors = vi.fn(async (authors: readonly string[]) => ({
      complete: true,
      rosterOps: authors.includes(adminPubkey)
        ? [spam, bootstrap, addSecondAdmin]
        : authors.includes(secondAdminPubkey)
          ? [addPhone]
          : [],
    }));

    const refreshed = await fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap],
      fetchAuthors,
    });

    expect(fetchAuthors.mock.calls.map(([authors]) => authors)).toEqual([
      [adminPubkey],
      [secondAdminPubkey],
    ]);
    expect(refreshed.projection.active_facets).toHaveProperty(adminPubkey);
    expect(refreshed.projection.active_facets).toHaveProperty(secondAdminPubkey);
    expect(refreshed.projection.active_facets).toHaveProperty(phonePubkey);
    expect(refreshed.projection.active_facets).not.toHaveProperty(attackerPubkey);
  });

  it('fails closed when relay completeness is not established instead of accepting a snapshot missing a revocation', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const addPhone = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 101, 'Phone', true, false),
      },
    });

    await expect(fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap, addPhone],
      fetchAuthors: async () => ({ complete: false, rosterOps: [] }),
    })).rejects.toThrow('complete Drive roster snapshot');
  });

  it('rejects an EOSE-marked partial snapshot that omits known author history', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });

    await expect(fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap],
      fetchAuthors: async () => ({ complete: true, rosterOps: [] }),
    })).rejects.toThrow('complete Drive roster snapshot');
  });

  it('applies a fetched revocation and never asks relays for an event-count-limited profile query', async () => {
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const phonePubkey = getPublicKey(generateSecretKey());
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(adminPubkey, 100, 'Admin', true, true),
      },
    });
    const addPhone = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(phonePubkey, 101, 'Phone', true, false),
      },
    });
    const revokePhone = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addPhone.op_id],
      createdAt: 102,
      op: { op: 'tombstone_facet', pubkey: phonePubkey },
    });

    const refreshed = await fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap, addPhone],
      fetchAuthors: async () => ({ complete: true, rosterOps: [bootstrap, addPhone, revokePhone] }),
    });

    expect(refreshed.projection.active_facets).not.toHaveProperty(phonePubkey);
    expect(refreshed.projection.tombstones).toHaveProperty(phonePubkey);
    expect(rosterAuthorFilter(PROFILE_ID, [adminPubkey])).toEqual({
      kinds: [7368],
      '#i': [PROFILE_ID],
      authors: [adminPubkey],
    });
  });

  it('does not let malformed events from a revoked admin block authoritative refresh', async () => {
    const firstAdminSecret = generateSecretKey();
    const firstAdminPubkey = getPublicKey(firstAdminSecret);
    const currentAdminSecret = generateSecretKey();
    const currentAdminPubkey = getPublicKey(currentAdminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      createdAt: 100,
      op: {
        op: 'add_facet',
        facet: appFacet(firstAdminPubkey, 100, 'First admin', true, true),
      },
    });
    const addCurrentAdmin = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: appFacet(currentAdminPubkey, 101, 'Current admin', true, true),
      },
    });
    const revokeFirstAdmin = signNostrIdentityRosterOp({
      signerSecretKey: currentAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addCurrentAdmin.op_id],
      createdAt: 102,
      op: { op: 'tombstone_facet', pubkey: firstAdminPubkey },
    });
    const malformedRevokedOp = signNostrIdentityRosterOp({
      signerSecretKey: firstAdminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id, addCurrentAdmin.op_id, 'ff'.repeat(32)],
      createdAt: 103,
      op: { op: 'tombstone_facet', pubkey: currentAdminPubkey },
    });
    const fetchAuthors = vi.fn(async () => ({
      complete: true,
      rosterOps: [bootstrap, addCurrentAdmin, revokeFirstAdmin, malformedRevokedOp],
    }));

    const refreshed = await fetchAuthoritativeDriveRoster({
      profileId: PROFILE_ID,
      trustedRosterOps: [bootstrap, addCurrentAdmin, revokeFirstAdmin],
      fetchAuthors,
    });

    expect(fetchAuthors).toHaveBeenCalledTimes(1);
    expect(fetchAuthors).toHaveBeenCalledWith([currentAdminPubkey]);
    expect(refreshed.projection.active_facets).not.toHaveProperty(firstAdminPubkey);
    expect(refreshed.projection.active_facets).toHaveProperty(currentAdminPubkey);
  });
});
