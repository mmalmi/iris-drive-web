import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import {
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  NOSTR_IDENTITY_DEVICE_APPROVAL_REQUEST_EVENT_TYPE,
  createDeviceApprovalBootstrap,
} from '@iris/identity';
import NDK, { NDKRelay, NDKRelaySet, type NostrEvent } from 'ndk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDriveDeviceApprovalDraft,
  DRIVE_DEVICE_APPROVAL_RELAY_URL,
} from '../src/drive/deviceLink';
import {
  createDriveDeviceApprovalRelayClient,
  driveDeviceApprovalRequestFilter,
  driveDeviceApprovalRequestRelayUrls,
  publishDriveDeviceApprovalArtifacts,
  subscribeDriveDeviceApprovalRelay,
  type DriveDeviceApprovalRelayClient,
} from '../src/nostr/deviceApprovalRelay';

describe('Drive device approval request relay', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses the fixed relay and indexes requests by both bootstrap keys', () => {
    const draft = createDriveDeviceApprovalDraft({ requestedAt: 1_700_000_000 });
    const relaySetFactory = vi.spyOn(NDKRelaySet, 'fromRelayUrls').mockImplementation(
      (relayUrls, approvalNdk) => new NDKRelaySet(new Set([
        new NDKRelay(relayUrls[0], undefined, approvalNdk),
      ]), approvalNdk),
    );
    const client = createDriveDeviceApprovalRelayClient();

    expect(driveDeviceApprovalRequestRelayUrls(draft.request)).toEqual([
      DRIVE_DEVICE_APPROVAL_RELAY_URL,
    ]);
    expect(client.ndk.transportPlugins).toEqual([]);
    expect(client.relaySet.size).toBe(1);
    expect(relaySetFactory).toHaveBeenCalledWith(
      [DRIVE_DEVICE_APPROVAL_RELAY_URL],
      client.ndk,
    );
    expect(driveDeviceApprovalRequestFilter(
      createDeviceApprovalBootstrap(draft.request),
    )).toEqual({
      kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
      authors: [draft.request.requestPubkey],
      '#p': [draft.request.deviceAppKeyPubkey],
      '#type': [NOSTR_IDENTITY_DEVICE_APPROVAL_REQUEST_EVENT_TYPE],
      limit: 20,
    });
  });

  it('fails closed without exactly one signed request relay', () => {
    const draft = createDriveDeviceApprovalDraft({ requestedAt: 1_700_000_000 });

    expect(() => driveDeviceApprovalRequestRelayUrls({
      ...draft.request,
      resources: draft.request.resources?.filter((resource) => resource.type !== 'nostr_relay'),
    })).toThrow('exactly one request relay');
    expect(() => driveDeviceApprovalRequestRelayUrls({
      ...draft.request,
      resources: [
        ...(draft.request.resources ?? []),
        {
          type: 'nostr_relay',
          id: 'wss://second.example',
          scopes: ['device_approval'],
        },
      ],
    })).toThrow('at most one relay');
  });

  it('rejects matching events delivered by an ordinary relay', () => {
    const ndk = new NDK({ explicitRelayUrls: [] });
    const requestRelay = new NDKRelay(DRIVE_DEVICE_APPROVAL_RELAY_URL, undefined, ndk);
    const ordinaryRelay = new NDKRelay('wss://ordinary.example', undefined, ndk);
    const relaySet = new NDKRelaySet(new Set([requestRelay]), ndk);
    const client = { ndk, relaySet };
    const subscription = subscribeDriveDeviceApprovalRelay(client, { kinds: [1] });
    const received: string[] = [];
    subscription.on('event', (event) => received.push(event.id));
    const event = finalizeEvent({
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'approval',
    }, generateSecretKey()) as NostrEvent;

    ndk.subManager.dispatchEvent(event, ordinaryRelay);
    expect(received).toEqual([]);

    ndk.subManager.dispatchEvent(event, requestRelay);
    expect(received).toEqual([event.id]);
    subscription.stop();
  });

  it('rejects ordinary transport plugins before publishing or fetching', async () => {
    const ndk = new NDK({ explicitRelayUrls: [] });
    const requestRelay = new NDKRelay(DRIVE_DEVICE_APPROVAL_RELAY_URL, undefined, ndk);
    const client: DriveDeviceApprovalRelayClient = {
      ndk,
      relaySet: new NDKRelaySet(new Set([requestRelay]), ndk),
    };
    const onPublish = vi.fn();
    const onSubscribe = vi.fn();
    client.ndk.transportPlugins.push({ onPublish, onSubscribe });
    const event = finalizeEvent({
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'approval',
    }, generateSecretKey()) as NostrEvent;

    expect(() => subscribeDriveDeviceApprovalRelay(client, { kinds: [1] }))
      .toThrow('must not use ordinary transport plugins');
    await expect(publishDriveDeviceApprovalArtifacts(client, [event]))
      .rejects.toThrow('must not use ordinary transport plugins');
    expect(onSubscribe).not.toHaveBeenCalled();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('requires an explicit relay acceptance for every artifact', async () => {
    const ndk = new NDK({ explicitRelayUrls: [] });
    const event = finalizeEvent({
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'approval',
    }, generateSecretKey()) as NostrEvent;
    const rejectedRelaySet = {
      size: 1,
      relayUrls: [DRIVE_DEVICE_APPROVAL_RELAY_URL],
      publish: async () => new Set(),
    } as unknown as NDKRelaySet;
    const client = { ndk, relaySet: rejectedRelaySet };

    await expect(publishDriveDeviceApprovalArtifacts(client, [event]))
      .rejects.toThrow('request relay did not accept');
  });
});
