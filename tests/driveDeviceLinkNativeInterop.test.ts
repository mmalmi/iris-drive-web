import { describe, expect, it } from 'vitest';
import type { Event as NostrToolsEvent } from 'nostr-tools';
import { parseDriveDeviceLinkRequestEventForAdmin } from '../src/nostr/auth';

const nativeAppKeyLinkRequestEvent: NostrToolsEvent = {
  kind: 30078,
  created_at: 1_782_377_000,
  tags: [
    ['d', 'iris-drive/123e4567-e89b-42d3-a456-426614174099/app-key-link-request'],
  ],
  content: JSON.stringify({
    schema: 1,
    profile_id: '123e4567-e89b-42d3-a456-426614174099',
    app_key_pubkey: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
    link_secret: 'native-join-secret',
    label: 'iPhone 15 Pro',
    requested_at: 1_782_377_000,
    url: 'iris-drive://app-key-link?profile=123e4567-e89b-42d3-a456-426614174099&app_key=npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul&secret=native-join-secret&label=iPhone%2015%20Pro',
  }),
  pubkey: '1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f',
  id: '0695d4b542d50e6dcd1df4d4979972b2547d401a87a9f1bf27072aeaa37268da',
  sig: '298b0d2242105f822bc7a7d6324243b4e9bd3f8a99800899f1a69c244727aa2b5fa23ccdb3e8168308afde6d324edfdef5a34db3070ce997d5c8e47e5710bf10',
};

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

async function hashDeviceLinkSecret(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return base64UrlEncode(new Uint8Array(digest));
}

describe('native app-key-link request interop', () => {
  it('parses the native app-key-link event shape as a Drive device link request', async () => {
    const frame = JSON.parse(nativeAppKeyLinkRequestEvent.content) as {
      profile_id: string;
      app_key_pubkey: string;
      link_secret: string;
      label: string;
      requested_at: number;
    };
    const adminAppKeyPubkey = 'a'.repeat(64);

    const parsed = await parseDriveDeviceLinkRequestEventForAdmin(nativeAppKeyLinkRequestEvent, {
      profileId: frame.profile_id,
      adminAppKeyPubkey,
      linkSecretHash: await hashDeviceLinkSecret(frame.link_secret),
    });

    expect(parsed?.pubkey).toBe(frame.app_key_pubkey);
    expect(parsed?.label).toBe('iPhone 15 Pro');
    expect(parsed?.requestedAt).toBe(frame.requested_at);
    expect(parsed?.request).toMatchObject({
      profileId: frame.profile_id,
      adminAppKeyPubkey,
      deviceAppKeyPubkey: frame.app_key_pubkey,
      linkSecret: frame.link_secret,
      label: frame.label,
      requestedAt: frame.requested_at,
    });
  });

  it('rejects the native app-key-link event when the invite secret hash does not match', async () => {
    const frame = JSON.parse(nativeAppKeyLinkRequestEvent.content) as { profile_id: string };

    await expect(parseDriveDeviceLinkRequestEventForAdmin(nativeAppKeyLinkRequestEvent, {
      profileId: frame.profile_id,
      adminAppKeyPubkey: 'a'.repeat(64),
      linkSecretHash: await hashDeviceLinkSecret('wrong-secret'),
    })).resolves.toBeNull();
  });
});
