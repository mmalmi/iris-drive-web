import NDK, {
  NDKEvent,
  NDKRelaySet,
  NDKSubscriptionCacheUsage,
  type NDKFilter,
  type NDKSubscription,
  type NDKSubscriptionOptions,
  type NostrEvent,
} from 'ndk';
import {
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  NOSTR_IDENTITY_DEVICE_APPROVAL_REQUEST_EVENT_TYPE,
  nostrIdentityDeviceApprovalRequestRelays,
  npubToPubkey,
  type NostrIdentityDeviceApprovalBootstrap,
  type NostrIdentityDeviceApprovalRequest,
} from '@iris/identity';
import { DRIVE_DEVICE_APPROVAL_RELAY_URL } from '../drive/deviceLink';

export interface DriveDeviceApprovalRelayClient {
  ndk: NDK;
  relaySet: NDKRelaySet;
}

export function driveDeviceApprovalRequestRelayUrls(
  request: NostrIdentityDeviceApprovalRequest,
): string[] {
  const relayUrls = nostrIdentityDeviceApprovalRequestRelays(request);
  if (relayUrls.length !== 1) {
    throw new Error('Drive device approval request must select exactly one request relay');
  }
  return relayUrls;
}

export function driveDeviceApprovalRequestFilter(
  bootstrap: NostrIdentityDeviceApprovalBootstrap,
): NDKFilter<number> {
  const requestPubkey = npubToPubkey(bootstrap.requestNpub);
  const deviceAppKeyPubkey = npubToPubkey(bootstrap.deviceAppKeyNpub);
  if (!requestPubkey || !deviceAppKeyPubkey || requestPubkey === deviceAppKeyPubkey) {
    throw new Error('Invalid Drive device approval bootstrap keys');
  }
  return {
    kinds: [KIND_NOSTR_IDENTITY_ROSTER_OP],
    authors: [requestPubkey],
    '#p': [deviceAppKeyPubkey],
    '#type': [NOSTR_IDENTITY_DEVICE_APPROVAL_REQUEST_EVENT_TYPE],
    limit: 20,
  };
}

export function createDriveDeviceApprovalRelayClient(
): DriveDeviceApprovalRelayClient {
  const approvalNdk = new NDK({ explicitRelayUrls: [] });
  return {
    ndk: approvalNdk,
    relaySet: NDKRelaySet.fromRelayUrls(
      [DRIVE_DEVICE_APPROVAL_RELAY_URL],
      approvalNdk,
    ),
  };
}

export function closeDriveDeviceApprovalRelayClient(
  client: DriveDeviceApprovalRelayClient,
): void {
  for (const relay of client.relaySet.relays) {
    try {
      relay.disconnect();
    } catch {
      // The request operation is already complete; leave no relay connection behind.
    }
  }
}

export function driveDeviceApprovalSubscriptionOptions(
  relaySet: NDKRelaySet,
): NDKSubscriptionOptions {
  return {
    relaySet,
    exclusiveRelay: true,
    closeOnEose: true,
    cacheUsage: NDKSubscriptionCacheUsage.ONLY_RELAY,
    groupable: false,
    skipOptimisticPublishEvent: true,
  };
}

export function subscribeDriveDeviceApprovalRelay(
  client: DriveDeviceApprovalRelayClient,
  filter: NDKFilter<number>,
): NDKSubscription {
  requireIsolatedDriveDeviceApprovalClient(client);
  return client.ndk.subscribe(
    filter,
    driveDeviceApprovalSubscriptionOptions(client.relaySet),
    false,
  );
}

export async function publishDriveDeviceApprovalArtifacts(
  client: DriveDeviceApprovalRelayClient,
  events: readonly NostrEvent[],
  timeoutMs = 5000,
): Promise<void> {
  requireIsolatedDriveDeviceApprovalClient(client);
  for (const event of events) {
    const acceptedBy = await new NDKEvent(client.ndk, event).publish(
      client.relaySet,
      timeoutMs,
      1,
    );
    if (acceptedBy.size < 1) {
      throw new Error('Drive device approval request relay did not accept the artifact');
    }
  }
}

function requireIsolatedDriveDeviceApprovalClient(
  client: DriveDeviceApprovalRelayClient,
): void {
  if (client.relaySet.size !== 1) {
    throw new Error('Drive device approval client must contain exactly one request relay');
  }
  if (client.ndk.transportPlugins.length > 0) {
    throw new Error('Drive device approval client must not use ordinary transport plugins');
  }
}
