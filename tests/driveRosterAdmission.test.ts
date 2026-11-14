import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { signNostrIdentityRosterOp } from '../src/drive/protocol';
import { decideRosterAdmission, type DriveRosterAdmission, type DriveRosterRelayAnswer } from '../src/nostr/driveRosterAdmission';
import { authorizedDriveFipsAppKeyPubkeys } from '../src/lib/driveFipsIdentity';
import { appFacet } from './driveProtocolInterop.helpers';

const PROFILE_ID = '5c1f2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const MAX_AGE = 10 * 60_000;

function roster() {
  const adminSecret = generateSecretKey();
  const adminPubkey = getPublicKey(adminSecret);
  const phonePubkey = getPublicKey(generateSecretKey());
  const bootstrap = signNostrIdentityRosterOp({
    signerSecretKey: adminSecret,
    profileId: PROFILE_ID,
    createdAt: 100,
    op: { op: 'add_facet', facet: appFacet(adminPubkey, 100, 'Admin', true, true) },
  });
  const addPhone = signNostrIdentityRosterOp({
    signerSecretKey: adminSecret,
    profileId: PROFILE_ID,
    parents: [bootstrap.op_id],
    createdAt: 101,
    op: { op: 'add_facet', facet: appFacet(phonePubkey, 101, 'Phone', true, false) },
  });
  const removePhone = signNostrIdentityRosterOp({
    signerSecretKey: adminSecret,
    profileId: PROFILE_ID,
    parents: [bootstrap.op_id, addPhone.op_id],
    createdAt: 102,
    op: { op: 'tombstone_facet', pubkey: phonePubkey },
  });
  return { adminSecret, adminPubkey, phonePubkey, bootstrap, addPhone, removePhone };
}

const answers = (...complete: boolean[]): DriveRosterRelayAnswer[] =>
  complete.map((done, index) => ({ relay: `wss://relay${index}.example`, complete: done }));

/** The devices admitted once the merged roster is held, as the FIPS admission reads them. */
const appKeys = (admission: DriveRosterAdmission) => authorizedDriveFipsAppKeyPubkeys(PROFILE_ID, admission.rosterOps);

describe('admitting the account\'s own devices', () => {
  it('is confirmed by the first relay that answers completely, while the others are down', () => {
    const { adminPubkey, phonePubkey, bootstrap, addPhone } = roster();
    const admission = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone],
      fetchedRosterOps: [bootstrap, addPhone],
      queriedAuthors: [adminPubkey],
      relays: answers(false, true, false, false, false),
      confirmedAt: null,
      now: 5_000,
      maxAgeMs: MAX_AGE,
    });
    expect(admission.status).toBe('confirmed');
    expect(admission.confirmedAt).toBe(5_000);
    expect(appKeys(admission)).toEqual([adminPubkey, phonePubkey].sort());
    expect(admission.unanswered).toEqual(['wss://relay0.example', 'wss://relay2.example', 'wss://relay3.example', 'wss://relay4.example']);
  });

  it('with no complete answer keeps a recent confirmation and fails closed once it is too old', () => {
    const { adminPubkey, phonePubkey, bootstrap, addPhone } = roster();
    const input = {
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone],
      fetchedRosterOps: [],
      queriedAuthors: [adminPubkey],
      relays: answers(false, false, false),
      confirmedAt: 1_000,
      maxAgeMs: MAX_AGE,
    };
    const recent = decideRosterAdmission({ ...input, now: 1_000 + MAX_AGE - 1 });
    expect(recent.status).toBe('provisional');
    expect(appKeys(recent)).toEqual([adminPubkey, phonePubkey].sort());

    const expired = decideRosterAdmission({ ...input, now: 1_000 + MAX_AGE });
    expect(expired.status).toBe('unconfirmed');

    const never = decideRosterAdmission({ ...input, confirmedAt: null, now: 1_000 });
    expect(never.status).toBe('unconfirmed');
  });

  it('applies a revocation from a relay that did not finish answering', () => {
    const { adminPubkey, bootstrap, addPhone, removePhone } = roster();
    const admission = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone],
      // The complete relay has not seen the revocation; a partial answer has it.
      fetchedRosterOps: [bootstrap, addPhone, removePhone],
      queriedAuthors: [adminPubkey],
      relays: answers(true, false),
      confirmedAt: null,
      now: 5_000,
      maxAgeMs: MAX_AGE,
    });
    expect(admission.status).toBe('confirmed');
    expect(appKeys(admission)).toEqual([adminPubkey]);
    expect(admission.rosterOps.map((op) => op.op_id)).toContain(removePhone.op_id);
  });

  it('removes a device whose revocation arrives later from another relay or the live roster', () => {
    const { adminPubkey, phonePubkey, bootstrap, addPhone, removePhone } = roster();
    const first = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone],
      fetchedRosterOps: [bootstrap, addPhone],
      queriedAuthors: [adminPubkey],
      relays: answers(true, false),
      confirmedAt: null,
      now: 5_000,
      maxAgeMs: MAX_AGE,
    });
    expect(appKeys(first)).toContain(phonePubkey);

    // The slow relay answers later with the revocation.
    const fromRelay = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: first.rosterOps,
      fetchedRosterOps: [bootstrap, addPhone, removePhone],
      queriedAuthors: [adminPubkey],
      relays: answers(false, true),
      confirmedAt: first.confirmedAt,
      now: 6_000,
      maxAgeMs: MAX_AGE,
    });
    expect(appKeys(fromRelay)).toEqual([adminPubkey]);

    // Or the live roster subscription brought it into the held roster, and no relay answers now.
    const fromLive = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone, removePhone],
      fetchedRosterOps: [],
      queriedAuthors: [adminPubkey],
      relays: answers(false, false),
      confirmedAt: first.confirmedAt,
      now: 6_000,
      maxAgeMs: MAX_AGE,
    });
    expect(fromLive.status).toBe('provisional');
    expect(appKeys(fromLive)).toEqual([adminPubkey]);
  });

  it('rejects operations that conflict with the held roster', () => {
    const { adminSecret, adminPubkey, bootstrap, addPhone, removePhone } = roster();
    const intruderSecret = generateSecretKey();
    const intruderPubkey = getPublicKey(intruderSecret);
    // A backdated fork that ignores the phone's addition and removal.
    const fork = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      createdAt: 103,
      op: { op: 'add_facet', facet: appFacet(intruderPubkey, 103, 'Fork', true, false) },
    });
    // A second bootstrap signed by someone who was never an admin.
    const selfAdded = signNostrIdentityRosterOp({
      signerSecretKey: intruderSecret,
      profileId: PROFILE_ID,
      createdAt: 1,
      op: { op: 'add_facet', facet: appFacet(intruderPubkey, 1, 'Intruder', true, true) },
    });
    const admission = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone, removePhone],
      fetchedRosterOps: [bootstrap, addPhone, removePhone, fork, selfAdded],
      queriedAuthors: [adminPubkey],
      relays: answers(true),
      confirmedAt: null,
      now: 5_000,
      maxAgeMs: MAX_AGE,
    });
    expect(appKeys(admission)).toEqual([adminPubkey]);
    expect(admission.rosterOps.map((op) => op.op_id)).not.toContain(fork.op_id);
    expect(admission.rosterOps.map((op) => op.op_id)).not.toContain(selfAdded.op_id);
  });

  it('is not confirmed by a complete answer that lacks an operation already held', () => {
    const { adminPubkey, bootstrap, addPhone } = roster();
    const admission = decideRosterAdmission({
      profileId: PROFILE_ID,
      heldRosterOps: [bootstrap, addPhone],
      fetchedRosterOps: [bootstrap],
      queriedAuthors: [adminPubkey],
      relays: answers(true, true),
      confirmedAt: null,
      now: 5_000,
      maxAgeMs: MAX_AGE,
    });
    expect(admission.status).toBe('unconfirmed');
  });
});
