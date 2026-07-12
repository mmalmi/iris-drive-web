import { describe, expect, test } from 'vitest';
import { identityFromSecretKey, toHex } from '@fips/core';
import { nip19 } from 'nostr-tools';
import {
  IRIS_DRIVE_FIPS_DISCOVERY_SCOPE,
  IRIS_DRIVE_FIPS_IDENTITY_STORE,
  compressedPubkeyHexToNpub,
  compressedPubkeyHexToXOnly,
  irisDriveFipsDiscoveryScope,
} from '../src/lib/driveFipsRuntime';

describe('drive FIPS runtime helpers', () => {
  test('uses the shared hashtree FIPS overlay topic', () => {
    expect(IRIS_DRIVE_FIPS_DISCOVERY_SCOPE).toBe('fips-overlay-v1');
    expect(IRIS_DRIVE_FIPS_IDENTITY_STORE).toBe('iris-fips-device');
    expect(irisDriveFipsDiscoveryScope()).toBe('fips-overlay-v1');
  });

  test('maps compressed FIPS peer ids to native npubs', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 1;
    const identity = await identityFromSecretKey(secret);
    const compressed = toHex(identity.publicKey);
    const xOnly = toHex(identity.xOnlyPubkey);

    expect(compressedPubkeyHexToXOnly(compressed)).toBe(xOnly);
    expect(compressedPubkeyHexToNpub(compressed)).toBe(nip19.npubEncode(xOnly));
    expect(() => compressedPubkeyHexToXOnly(xOnly)).toThrow(/invalid compressed FIPS peer id/);
  });
});
