import { describe, expect, test } from 'vitest';
import { identityFromSecretKey, toHex } from '@fips/core';
import { getPublicKey, nip19 } from 'nostr-tools';
import {
  attachDriveFipsProvider,
  driveFipsIdentityFromAppKeySecret,
  IRIS_DRIVE_FIPS_DISCOVERY_SCOPE,
  compressedPubkeyHexToNpub,
  compressedPubkeyHexToXOnly,
  irisDriveFipsDiscoveryScope,
} from '../src/lib/driveFipsRuntime';

describe('drive FIPS runtime helpers', () => {
  test('uses shared block discovery across profiles and applications', () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';

    expect(IRIS_DRIVE_FIPS_DISCOVERY_SCOPE).toBe('fips-overlay-v1');
    expect(irisDriveFipsDiscoveryScope()).toBe('fips-overlay-v1');
    expect(irisDriveFipsDiscoveryScope(profileId)).toBe('fips-overlay-v1');
  });

  test('derives the FIPS identity from the active Drive AppKey', async () => {
    const secret = new Uint8Array(32);
    secret[31] = 2;

    const identity = await driveFipsIdentityFromAppKeySecret(toHex(secret));

    expect(toHex(identity.xOnlyPubkey)).toBe(getPublicKey(secret));
  });

  test('attaches the active FIPS provider to the worker adapter', () => {
    const provider = { name: 'active-drive-provider' };
    const attached: unknown[] = [];

    const result = attachDriveFipsProvider(
      { setP2PProvider: (next) => attached.push(next) },
      { getP2PProvider: () => provider },
    );

    expect(result).toBe(provider);
    expect(attached).toEqual([provider]);
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
