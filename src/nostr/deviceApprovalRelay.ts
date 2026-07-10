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
  nostrIdentityDeviceApprovalRequestRelays,
  type NostrIdentityDeviceApprovalRequest,
} from '@iris/identity';

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

export function createDriveDeviceApprovalRelayClient(
  request: NostrIdentityDeviceApprovalRequest,
): DriveDeviceApprovalRelayClient {
  const approvalNdk = new NDK({ explicitRelayUrls: [] });
  return {
    ndk: approvalNdk,
    relaySet: NDKRelaySet.fromRelayUrls(
      driveDeviceApprovalRequestRelayUrls(request),
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
