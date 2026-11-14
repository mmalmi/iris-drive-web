// A My Drive root and phrase acceptance made by native Iris Drive
// (`cargo run -p iris-drive-core --example recovery_root_fixture`, iris-drive
// ecefb047). The web must open the root with the recovery phrase alone and
// read the acceptance its phrase sign-in looks for.
import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { toHex } from '@hashtree/core';
import { parseDriveRootEventForDevice } from '../src/drive/protocol';
import { parseNostrIdentityFacetAcceptanceEvent } from '../src/drive/protocolProfileEvents';
import { normalizeRecoveryPhrase } from '../src/drive/recoveryPhrase';
import { rootWrapRecipients } from '../src/drive/recoveryRootKeys';
import fixture from './fixtures/native-recovery-root.json';

const recoveryKey = privateKeyFromSeedWords(normalizeRecoveryPhrase(fixture.phrase));

describe('a native root and the recovery phrase', () => {
  it('derives the same recovery key from the phrase', () => {
    expect(getPublicKey(recoveryKey)).toBe(fixture.recoveryPubkey);
  });

  it('opens a native root with the phrase alone, as a new device that has no wrap of its own', () => {
    const event = fixture.rootEvent as Event;
    expect(verifyEvent(event)).toBe(true);
    expect(rootWrapRecipients(event)).toEqual(new Set([fixture.deviceAppKeyPubkey, fixture.recoveryPubkey]));
    const newDevice = generateSecretKey();
    expect(() => parseDriveRootEventForDevice(event, newDevice)).toThrow();
    const parsed = parseDriveRootEventForDevice(event, newDevice, [recoveryKey]);
    expect(toHex(parsed.root.hash)).toBe(fixture.rootHashHex);
    expect(parsed.root.key ? toHex(parsed.root.key) : null).toBe(fixture.rootKeyHex);
    expect(parsed.root_scope_id).toBe(fixture.profileId);
  });

  it('reads the acceptance the phrase signed, naming the step that added it', () => {
    const event = fixture.acceptanceEvent as Event;
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(fixture.recoveryPubkey);
    expect(event.tags).toContainEqual(['p', fixture.recoveryPubkey]);
    const acceptance = parseNostrIdentityFacetAcceptanceEvent(event);
    expect(acceptance).toBeTruthy();
    const addStep = (fixture.rosterEvents as Event[]).find((roster) => event.tags.some(([name, value]) => name === 'roster_op_id' && value === roster.id));
    expect(addStep).toBeTruthy();
  });
});
