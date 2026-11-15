/** Two browsers of one Drive account, connected over FIPS through a local seed. */
import { expect, test as base, type Page } from './fixtures';
import { startLocalFipsWebSocketSeed } from './fixtures/localFipsWebSocketSeed';

export const fipsTest = base.extend<{ fipsSeedUrl: string }>({
  fipsSeedUrl: async ({}, use) => {
    const seed = await startLocalFipsWebSocketSeed();
    try {
      await use(seed.url);
    } finally {
      await seed.close();
    }
  },
});

export interface DriveDevice {
  profileId: string;
  appKeyPubkey: string;
}

export interface FipsState {
  active: boolean;
  localPeerId: string;
  localXOnlyPubkey: string;
  connectedPeerIds: string[];
  nostrPeerIds: string[];
  providerPeerIds: string[];
}

export async function fipsState(page: Page): Promise<FipsState> {
  return page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const runtime = getDriveFipsRuntime();
    const stats = runtime?.getStats();
    return {
      active: stats?.active === true,
      localPeerId: stats?.localPeerId ?? '',
      localXOnlyPubkey: stats?.localXOnlyPubkey ?? '',
      connectedPeerIds: stats?.connectedPeerIds ?? [],
      nostrPeerIds: stats?.nostrPeerIds ?? [],
      providerPeerIds: runtime && stats?.active
        ? await runtime.getP2PProvider().listPeerIds().catch(() => [])
        : [],
    };
  });
}

export async function linkBrowserDevice(ownerPage: Page, devicePage: Page): Promise<DriveDevice> {
  const request = await devicePage.evaluate(async () => {
    const { createDriveDeviceApprovalLink } = await import('/src/nostr');
    const link = createDriveDeviceApprovalLink({ label: 'FIPS browser' });
    (window as typeof window & { __fipsApprovalLink?: unknown }).__fipsApprovalLink = link;
    return {
      appKeyPubkey: link.appKeyPubkey,
      bootstrap: link.pendingApproval.bootstrap,
    };
  });

  await devicePage.evaluate(async () => {
    const link = (window as typeof window & {
      __fipsApprovalLink?: {
        pendingApproval: unknown;
        appKeyNsec: string;
      };
      __fipsApproval?: Promise<DriveDevice>;
    }).__fipsApprovalLink;
    if (!link) throw new Error('Drive device approval link is missing');
    const { activateDriveDeviceApprovalIfApproved } = await import('/src/nostr');
    (window as typeof window & {
      __fipsApproval?: Promise<DriveDevice>;
    }).__fipsApproval = activateDriveDeviceApprovalIfApproved(
      link.pendingApproval as never,
      link.appKeyNsec,
      { timeoutMs: 60_000 },
    ).then((activation) => {
      if (!activation) throw new Error('Drive device approval was not activated');
      return {
        profileId: activation.session.profileId,
        appKeyPubkey: activation.session.appKeyPubkey,
      };
    });
  });

  await ownerPage.evaluate(async (bootstrap) => {
    const { approveDriveDeviceApprovalBootstrap } = await import('/src/nostr');
    await approveDriveDeviceApprovalBootstrap(bootstrap as never);
  }, request.bootstrap);

  const activated = await devicePage.evaluate(() => (
    window as typeof window & { __fipsApproval?: Promise<DriveDevice> }
  ).__fipsApproval);
  expect(activated.appKeyPubkey).toBe(request.appKeyPubkey);
  return activated;
}

