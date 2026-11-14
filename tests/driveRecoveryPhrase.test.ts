import { describe, expect, it } from 'vitest';
import { createAttachedNostrIdentitySession, createNostrIdentitySignerFromSecretKey } from '@iris/identity';
import { generateSecretKey, getPublicKey, nip44, verifyEvent, type Event } from 'nostr-tools';
import { decryptDriveDeviceLabelsWithDck, encryptedDeviceLabelPayloadsFromEventJson } from '../src/drive/deviceLabels';
import {
  createNostrIdentityDckRewrapOp,
  createNostrIdentityDckRotateAfterAddOp,
  parseNostrIdentityRosterOpEvent,
  projectNostrIdentityRoster,
  signNostrIdentityRosterOp,
  type SignedNostrIdentityRosterOp,
} from '../src/drive/protocol';
import {
  activeRecoveryPhraseFacets,
  createRecoveryPhraseRosterOps,
  generateRecoveryPhrase,
  pickConfirmationWordIndexes,
  recoveryPhraseFacet,
  recoveryPhrasePubkey,
  recoveryPhraseSecretKey,
  validateRecoveryPhrase,
} from '../src/drive/recoveryPhrase';
import nativeVector from './fixtures/native-recovery-phrase.json';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174321';
const NATIVE_EVENTS = nativeVector.rosterEvents as Event[];

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** The tags that describe the added key. The web also tags its own signer with `p`; native does not. */
function keyTags(event: Event): string[][] {
  const names = ['op', 'p', 'key_pubkey', 'key_purpose', 'key_capability', 'key_label'];
  return event.tags
    .filter((tag) => names.includes(tag[0]) && !(tag[0] === 'p' && tag[1] === event.pubkey))
    .map((tag) => tag.slice())
    .sort();
}

function nativeRecoveryAddEvent(): Event {
  const event = NATIVE_EVENTS.find((candidate) => candidate.tags.some(
    (tag) => tag[0] === 'key_pubkey' && tag[1] === nativeVector.recoveryPubkey,
  ));
  if (!event) throw new Error('fixture has no recovery add_key event');
  return event;
}

/** A web account as `createDriveProfile` leaves it: one admin device and Drive key epoch 1. */
async function webAdminProfile(): Promise<{
  adminSecret: Uint8Array;
  adminPubkey: string;
  rosterOps: SignedNostrIdentityRosterOp[];
}> {
  const adminSecret = generateSecretKey();
  const adminPubkey = getPublicKey(adminSecret);
  const bootstrap = signNostrIdentityRosterOp({
    signerSecretKey: adminSecret,
    profileId: PROFILE_ID,
    createdAt: 100,
    clientNonce: 'bootstrap',
    op: {
      op: 'add_facet',
      facet: {
        pubkey: adminPubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_secret_wraps: true,
          can_decrypt_secret_epochs: true,
        },
        added_at: 100,
      },
    },
  });
  const firstEpoch = await createNostrIdentityDckRotateAfterAddOp({
    profileId: PROFILE_ID,
    signer: createNostrIdentitySignerFromSecretKey(adminSecret),
    rosterOps: [],
    parentRosterOp: bootstrap,
    createdAt: 101,
    clientNonce: 'bootstrap:create-dck',
    dckPlaintext: 'aa'.repeat(32),
  });
  return { adminSecret, adminPubkey, rosterOps: [bootstrap, firstEpoch] };
}

describe('recovery phrase derivation', () => {
  it('gives the key native gives for its own test phrase', () => {
    expect(hex(recoveryPhraseSecretKey(nativeVector.phrase))).toBe(nativeVector.secretKeyHex);
    expect(recoveryPhrasePubkey(nativeVector.phrase)).toBe(nativeVector.recoveryPubkey);
  });

  it('ignores case and spacing, as native does', () => {
    const shouty = nativeVector.phrase.toUpperCase().split(' ').join(' \n ');
    expect(validateRecoveryPhrase(`  ${shouty}  `)).toBe(nativeVector.phrase);
    expect(recoveryPhrasePubkey(shouty)).toBe(nativeVector.recoveryPubkey);
  });

  it('takes exactly 12 words with a valid checksum', () => {
    const twentyFour = `${'abandon '.repeat(23)}art`;
    expect(() => validateRecoveryPhrase(twentyFour)).toThrow('12 words');
    expect(() => validateRecoveryPhrase('abandon '.repeat(12))).toThrow('not a recovery phrase');
  });

  it('makes 12 valid words', () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(' ')).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(phrase);
    expect(generateRecoveryPhrase()).not.toBe(phrase);
  });

  it('asks back two different words', () => {
    for (const random of [() => 0, () => 0.999, Math.random, Math.random, Math.random]) {
      const [first, second] = pickConfirmationWordIndexes(12, random);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(second).toBeLessThan(12);
      expect(first).toBeLessThan(second);
    }
  });
});

describe('recovery phrase key on the wire', () => {
  it('reads a recovery phrase key that native added', () => {
    const rosterOps = NATIVE_EVENTS.map((event) => parseNostrIdentityRosterOpEvent(event));
    const projection = projectNostrIdentityRoster(nativeVector.profileId, rosterOps);
    const added = Number(nativeRecoveryAddEvent().tags.find((tag) => tag[0] === 'key_added_at')![1]);
    expect(activeRecoveryPhraseFacets(projection)).toEqual([
      recoveryPhraseFacet(nativeVector.recoveryPubkey, added),
    ]);
  });

  it('writes the same key description native writes', async () => {
    const { adminSecret, rosterOps } = await webAdminProfile();
    const ops = await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps,
      recoveryPhrase: nativeVector.phrase,
      createdAt: 200,
      clientNonce: 'add-recovery',
    });
    const web = JSON.parse(ops!.addOp.event_json) as Event;
    const native = nativeRecoveryAddEvent();
    expect(keyTags(web)).toEqual(keyTags(native));
  });
});

describe('adding a recovery phrase', () => {
  it('adds the key, then a new Drive key epoch the phrase can open', async () => {
    const { adminSecret, adminPubkey, rosterOps } = await webAdminProfile();
    const phrase = generateRecoveryPhrase();
    const recoverySecret = recoveryPhraseSecretKey(phrase);
    const recoveryPubkey = getPublicKey(recoverySecret);
    const dckPlaintext = 'bb'.repeat(32);

    const ops = await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps,
      recoveryPhrase: phrase,
      createdAt: 200,
      clientNonce: 'add-recovery',
      deviceLabels: { [adminPubkey]: 'Firefox on Linux' },
      dckPlaintext,
    });
    expect(ops).not.toBeNull();
    const { addOp, dckRotationOp, acceptance } = ops!;

    expect(addOp.signer_pubkey).toBe(adminPubkey);
    expect([...addOp.content.parents].sort()).toEqual(rosterOps.map((op) => op.op_id).sort());
    expect(addOp.content.op).toEqual({ op: 'add_facet', facet: recoveryPhraseFacet(recoveryPubkey, 200) });
    expect(dckRotationOp.signer_pubkey).toBe(adminPubkey);
    expect(dckRotationOp.content.created_at).toBe(201);
    expect(dckRotationOp.content.op).toMatchObject({ op: 'rotate_secret_epoch', epoch: 2 });

    const projection = projectNostrIdentityRoster(PROFILE_ID, [...rosterOps, addOp, dckRotationOp]);
    expect(projection.rejected_op_ids).toEqual([]);
    expect(activeRecoveryPhraseFacets(projection).map((facet) => facet.pubkey)).toEqual([recoveryPubkey]);
    const epoch = projection.secret_epochs['2'];
    expect(Object.keys(epoch.wrapped_secrets).sort()).toEqual([adminPubkey, recoveryPubkey].sort());
    const opened = nip44.v2.decrypt(
      epoch.wrapped_secrets[recoveryPubkey],
      nip44.v2.utils.getConversationKey(recoverySecret, adminPubkey),
    );
    expect(opened).toBe(dckPlaintext);

    // Device names stay readable under the new key.
    const [sealed] = encryptedDeviceLabelPayloadsFromEventJson(addOp.event_json);
    const labels = await decryptDriveDeviceLabelsWithDck(sealed, dckPlaintext);
    expect(labels).toMatchObject({ profileId: PROFILE_ID, secretEpoch: 2, labels: { [adminPubkey]: 'Firefox on Linux' } });

    // Signed by the phrase and naming itself, which is how sign-in finds the account.
    const acceptanceEvent = JSON.parse(acceptance.event_json) as Event;
    expect(verifyEvent(acceptanceEvent)).toBe(true);
    expect(acceptanceEvent.pubkey).toBe(recoveryPubkey);
    expect(acceptanceEvent.tags).toContainEqual(['p', recoveryPubkey]);
    expect(acceptance.content).toMatchObject({
      profile_id: PROFILE_ID,
      facet_pubkey: recoveryPubkey,
      purposes: ['recovery_phrase'],
      roster_op_id: addOp.op_id,
    });
  });

  it('lets the phrase alone bring in a new device that can open the Drive key', async () => {
    const { adminSecret, rosterOps } = await webAdminProfile();
    const phrase = generateRecoveryPhrase();
    const dckPlaintext = 'cc'.repeat(32);
    const ops = await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps,
      recoveryPhrase: phrase,
      createdAt: 200,
      clientNonce: 'add-recovery',
      dckPlaintext,
    });
    const known = [...rosterOps, ops!.addOp, ops!.dckRotationOp];

    const signer = createNostrIdentitySignerFromSecretKey(recoveryPhraseSecretKey(phrase), 'seed_phrase');
    const newDeviceSecret = generateSecretKey();
    const { attachment, session } = await createAttachedNostrIdentitySession({
      profileId: PROFILE_ID,
      signer,
      rosterOps: known,
      appKeySecretKey: newDeviceSecret,
      // As sign-in does, and as native does: the recovered device is an admin.
      capabilities: {
        can_write_roots: true,
        can_admin_profile: true,
        can_recover_app_keys: true,
        can_receive_secret_wraps: true,
        can_decrypt_secret_epochs: true,
      },
      createdAt: 300,
      clientNonce: 'recover',
    });
    const rewrap = await createNostrIdentityDckRewrapOp({
      profileId: PROFILE_ID,
      signer,
      rosterOps: known,
      appKeyPubkey: attachment.appKeyPubkey,
      parentRosterOp: attachment.rosterOp,
      createdAt: 301,
    });
    const projection = projectNostrIdentityRoster(PROFILE_ID, [...session.rosterOps, rewrap!]);
    expect(projection.active_facets[attachment.appKeyPubkey]?.capabilities?.can_admin_profile).toBe(true);
    const latest = projection.secret_epochs['3'];
    expect(nip44.v2.decrypt(
      latest.wrapped_secrets[attachment.appKeyPubkey],
      nip44.v2.utils.getConversationKey(newDeviceSecret, latest.signed_by_pubkey),
    )).toBe(dckPlaintext);
  });

  it('adds a second phrase next to the first, and the same phrase only once', async () => {
    const { adminSecret, rosterOps } = await webAdminProfile();
    const first = generateRecoveryPhrase();
    const firstOps = await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps,
      recoveryPhrase: first,
      createdAt: 200,
      clientNonce: 'first',
    });
    const afterFirst = [...rosterOps, firstOps!.addOp, firstOps!.dckRotationOp];
    expect(await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps: afterFirst,
      recoveryPhrase: first,
      createdAt: 210,
      clientNonce: 'again',
    })).toBeNull();

    const secondOps = await createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: adminSecret,
      rosterOps: afterFirst,
      recoveryPhrase: generateRecoveryPhrase(),
      createdAt: 220,
      clientNonce: 'second',
    });
    const projection = projectNostrIdentityRoster(PROFILE_ID, [...afterFirst, secondOps!.addOp, secondOps!.dckRotationOp]);
    expect(activeRecoveryPhraseFacets(projection).map((facet) => facet.added_at)).toEqual([200, 220]);
    expect(Object.keys(projection.secret_epochs['3'].wrapped_secrets)).toHaveLength(3);
  });

  it('needs an admin device', async () => {
    const { adminSecret, rosterOps } = await webAdminProfile();
    const memberSecret = generateSecretKey();
    const member = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: projectNostrIdentityRoster(PROFILE_ID, rosterOps).accepted_op_ids,
      createdAt: 150,
      clientNonce: 'member',
      op: {
        op: 'add_facet',
        facet: {
          pubkey: getPublicKey(memberSecret),
          purposes: ['app_key'],
          capabilities: { can_write_roots: true, can_receive_secret_wraps: true, can_decrypt_secret_epochs: true },
          added_at: 150,
        },
      },
    });
    await expect(createRecoveryPhraseRosterOps({
      profileId: PROFILE_ID,
      appKeySecretKey: memberSecret,
      rosterOps: [...rosterOps, member],
      recoveryPhrase: generateRecoveryPhrase(),
      createdAt: 200,
      clientNonce: 'member-tries',
    })).rejects.toThrow('admin');
  });
});
