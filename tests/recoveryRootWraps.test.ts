import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { buildDriveRootEvent, parseDriveRootEventForDevice, type NostrIdentityRosterProjection } from '../src/drive/protocol';
import { holdRecoveryKey, heldRecoveryKeys, recoveryPhraseRecipients, rootWrapRecipients } from '../src/drive/recoveryRootKeys';
import { generateRecoveryPhrase } from '../src/drive/recoveryPhrase';

const PROFILE_ID = '0b4bd0b0-7a6f-4fb1-9c1e-7c7f2a4bfb1a';
const root = { hash: new Uint8Array(32).fill(7), key: new Uint8Array(32).fill(9) };

describe('Drive roots and recovery phrase keys', () => {
  it('lets a device holding only the recovery phrase open a root wrapped for it', () => {
    const writer = generateSecretKey();
    const otherDevice = generateSecretKey();
    const recovery = privateKeyFromSeedWords(generateRecoveryPhrase());
    const event = buildDriveRootEvent({
      deviceSecretKey: writer,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root,
      dckGeneration: 1,
      authorizedAppKeyPubkeys: [getPublicKey(otherDevice), getPublicKey(recovery)],
    });
    expect(rootWrapRecipients(event)).toEqual(new Set([getPublicKey(writer), getPublicKey(otherDevice), getPublicKey(recovery)]));

    // A new device let in by the phrase: no wrap of its own, but it holds the phrase's key.
    const newDevice = generateSecretKey();
    expect(() => parseDriveRootEventForDevice(event, newDevice)).toThrow(/unavailable/);
    const opened = parseDriveRootEventForDevice(event, newDevice, [recovery]);
    expect(opened.root).toEqual(root);

    // Its own wrap is used first, when it has one.
    expect(parseDriveRootEventForDevice(event, otherDevice, [generateSecretKey()]).root).toEqual(root);
  });

  it('wraps roots for the account’s recovery phrase keys and nothing else', () => {
    const projection = {
      active_facets: {
        a: { pubkey: 'a', purposes: ['app_key'] },
        r: { pubkey: 'r', purposes: ['recovery_phrase'] },
        n: { pubkey: 'n', purposes: ['nip46'] },
      },
    } as unknown as NostrIdentityRosterProjection;
    expect(recoveryPhraseRecipients(projection)).toEqual(['r']);
    expect(recoveryPhraseRecipients(null)).toEqual([]);
  });

  it('holds a recovery key in memory for opening roots', () => {
    const key = generateSecretKey();
    holdRecoveryKey(key);
    holdRecoveryKey(key);
    expect(heldRecoveryKeys().filter((held) => getPublicKey(held) === getPublicKey(key))).toHaveLength(1);
  });

  it('reads no recipients from a root it cannot parse', () => {
    expect(rootWrapRecipients({ content: 'not json' })).toEqual(new Set());
  });
});
