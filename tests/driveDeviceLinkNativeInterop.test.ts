import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event as NostrToolsEvent } from 'nostr-tools';
import { signDeviceLinkRequestEvent } from '@iris/identity';
import { parseDriveDeviceLinkRequestEventForAdmin } from '../src/nostr/auth';

const profileId = '123e4567-e89b-42d3-a456-426614174099';

type FakeNdkSubscription = {
  on: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emit: (name: string, event?: unknown) => void;
};

function createFakeNdkSubscription(): FakeNdkSubscription {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const subscription: FakeNdkSubscription = {
    on: vi.fn((name: string, callback: (event?: unknown) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
      return subscription;
    }),
    stop: vi.fn(),
    emit: (name: string, event?: unknown) => {
      for (const callback of listeners.get(name) ?? []) {
        callback(event);
      }
    },
  };
  return subscription;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../src/nostr/ndk');
});

describe('native app-key-link request interop', () => {
  it('parses encrypted identity fact-event device link requests', async () => {
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const adminAppKeyPubkey = 'a'.repeat(64);
    const event = signDeviceLinkRequestEvent({
      signerSecretKey: deviceSecret,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: device,
        requestedAt: 1_782_377_100,
        label: 'iPhone',
      },
      clientNonce: 'fact-request',
    });

    expect(event.kind).toBe(7368);
    expect(event.content).not.toBe('');
    expect(event.tags).toContainEqual(['p', invitePubkey]);
    expect(event.tags.some((tag) => tag[0] === 'admin_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'key_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'joining_pubkey')).toBe(false);
    expect(event.tags.some((tag) => tag[0] === 'link_secret_hash')).toBe(false);

    const parsed = await parseDriveDeviceLinkRequestEventForAdmin(event, {
      profileId,
      adminAppKeyPubkey,
      invitePubkey,
      inviteSecretKey: inviteSecret,
    });

    expect(parsed?.pubkey).toBe(device);
    expect(parsed?.label).toBe('iPhone');
    expect(parsed?.request).toMatchObject({
      profileId,
      adminAppKeyPubkey,
      invitePubkey,
      deviceAppKeyPubkey: device,
      requestedAt: 1_782_377_100,
      label: 'iPhone',
    });
  });

  it('rejects encrypted requests for another invite key', async () => {
    const deviceSecret = generateSecretKey();
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const otherInviteSecret = generateSecretKey();
    const adminAppKeyPubkey = 'a'.repeat(64);
    const event = signDeviceLinkRequestEvent({
      signerSecretKey: deviceSecret,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: getPublicKey(deviceSecret),
        requestedAt: 1_782_377_100,
      },
    });

    await expect(parseDriveDeviceLinkRequestEventForAdmin(event, {
      profileId,
      adminAppKeyPubkey,
      invitePubkey: getPublicKey(otherInviteSecret),
      inviteSecretKey: otherInviteSecret,
    })).resolves.toBeNull();
  });

  it('rejects old public-tag link request events', async () => {
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const legacyEvent = finalizeEvent({
      kind: 7368,
      created_at: 1_782_377_000,
      tags: [
        ['i', profileId, 'subject'],
        ['type', 'nostr_identity_link_request'],
        ['admin_pubkey', 'a'.repeat(64)],
        ['key_pubkey', device],
        ['link_secret_hash', 'old-hash'],
      ],
      content: '',
    }, deviceSecret) as NostrToolsEvent;
    const inviteSecret = generateSecretKey();

    await expect(parseDriveDeviceLinkRequestEventForAdmin(legacyEvent, {
      profileId,
      adminAppKeyPubkey: 'a'.repeat(64),
      invitePubkey: getPublicKey(inviteSecret),
      inviteSecretKey: inviteSecret,
    })).resolves.toBeNull();
  });

  it('parses previous native 30078 app-key-link frames for the active invite', async () => {
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const adminAppKeyPubkey = 'a'.repeat(64);
    const oldEvent = finalizeEvent({
      kind: 30078,
      created_at: 1_782_377_000,
      tags: [
        ['d', `iris-drive/${profileId}/app-key-link-request`],
      ],
      content: JSON.stringify({
        schema: 1,
        profile_id: profileId,
        admin_app_key_pubkey: adminAppKeyPubkey,
        app_key_pubkey: device,
        invite_pubkey: invitePubkey,
        label: 'TestFlight iPhone',
        requested_at: 1_782_377_000,
        url: `iris-drive://app-key-link?profile=${profileId}&app_key=${device}&invite=${invitePubkey}`,
      }),
    }, deviceSecret) as NostrToolsEvent;

    const parsed = await parseDriveDeviceLinkRequestEventForAdmin(oldEvent, {
      profileId,
      adminAppKeyPubkey,
      invitePubkey: getPublicKey(inviteSecret),
      inviteSecretKey: inviteSecret,
    });

    expect(parsed).toMatchObject({
      pubkey: device,
      label: 'TestFlight iPhone',
      requestedAt: 1_782_377_000,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: device,
        requestedAt: 1_782_377_000,
        label: 'TestFlight iPhone',
      },
    });
  });

  it('rejects old native 30078 app-key-link frames without the active invite pubkey', async () => {
    const inviteSecret = generateSecretKey();
    const oldEvent: NostrToolsEvent = finalizeEvent({
      kind: 30078,
      created_at: 1_782_377_000,
      tags: [
        ['d', `iris-drive/${profileId}/app-key-link-request`],
      ],
      content: JSON.stringify({
        schema: 1,
        profile_id: profileId,
        app_key_pubkey: getPublicKey(generateSecretKey()),
        link_secret: 'native-join-secret',
      }),
    }, generateSecretKey()) as NostrToolsEvent;

    await expect(parseDriveDeviceLinkRequestEventForAdmin(oldEvent, {
      profileId,
      adminAppKeyPubkey: 'a'.repeat(64),
      invitePubkey: getPublicKey(inviteSecret),
      inviteSecretKey: inviteSecret,
    })).resolves.toBeNull();
  });

  it('backs the admin request subscription with relay refetches', async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const subscriptions: FakeNdkSubscription[] = [];
    const subscribe = vi.fn((_filters, _options) => {
      const subscription = createFakeNdkSubscription();
      subscriptions.push(subscription);
      return subscription;
    });
    vi.doMock('../src/nostr/ndk', () => ({
      ndk: { subscribe },
      NDKEvent: class {},
      NDKNip07Signer: class {},
      NDKNip46Signer: class {},
      NDKPrivateKeySigner: class {},
    }));

    const { subscribeDriveDeviceLinkRequestsForAdmin } = await import('../src/nostr/auth');
    const deviceSecret = generateSecretKey();
    const device = getPublicKey(deviceSecret);
    const inviteSecret = generateSecretKey();
    const invitePubkey = getPublicKey(inviteSecret);
    const adminAppKeyPubkey = 'a'.repeat(64);
    const event = signDeviceLinkRequestEvent({
      signerSecretKey: deviceSecret,
      request: {
        profileId,
        adminAppKeyPubkey,
        invitePubkey,
        deviceAppKeyPubkey: device,
        requestedAt: 1_782_377_100,
        label: 'iPhone',
      },
    });
    const received: unknown[][] = [];

    const stop = subscribeDriveDeviceLinkRequestsForAdmin({
      profileId,
      adminAppKeyPubkey,
      invitePubkey,
      inviteSecretKey: inviteSecret,
    }, (requests) => received.push(requests));

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kinds: [7368],
        '#i': [profileId],
        '#p': [invitePubkey],
      }),
      expect.objectContaining({
        kinds: [30078],
        '#d': [`iris-drive/${profileId}/app-key-link-request`],
      }),
    ]));
    expect(subscribe.mock.calls[0][1]).toMatchObject({ closeOnEose: false });
    expect(subscribe.mock.calls[1][1]).toMatchObject({ closeOnEose: true });

    subscriptions[1].emit('event', { rawEvent: () => event });
    subscriptions[1].emit('eose');

    await vi.waitFor(() => {
      expect(received.at(-1)).toMatchObject([
        {
          pubkey: device,
          label: 'iPhone',
          requestedAt: 1_782_377_100,
        },
      ]);
    });

    stop();
    expect(subscriptions[0].stop).toHaveBeenCalledOnce();
  });
});
