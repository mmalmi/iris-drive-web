import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(__dirname, '..');

describe('device approval route', () => {
  it('routes scanned device approval requests to the approval flow', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const route = fs.readFileSync(path.join(appRoot, 'src/routes/DeviceApprovalRoute.svelte'), 'utf8');
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(router).toContain("{ pattern: '/approve-device/:payload', component: DeviceApprovalRoute }");
    expect(router).toContain('<DeviceApprovalRoute payload={route.params.payload || \'\'} />');
    expect(route).toContain('https://drive.iris.to/approve-device/');
    expect(route).toContain('approveDriveDeviceApprovalBootstrap');
    expect(routerStore).toContain("pathname.startsWith('/approve-device/')");
  });

  it('does not expose the old invite route', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(router).not.toContain('DeviceInviteRoute');
    expect(router).not.toContain("'/invite/:payload'");
    expect(routerStore).not.toContain("pathname.startsWith('/invite/')");
  });

  it('uses approve-device as the visible settings add-device flow', () => {
    const settings = fs.readFileSync(path.join(appRoot, 'src/components/settings/UserSettings.svelte'), 'utf8');

    expect(settings).toContain('data-testid="device-approval-section"');
    expect(settings).toContain('data-testid="device-approval-input"');
    expect(settings).toContain('approveDriveDeviceApprovalBootstrap');
    expect(settings).not.toContain('showAddDeviceSection');
    expect(settings).not.toContain('createDriveDeviceLinkInvite');
    expect(settings).not.toContain('subscribeDriveDeviceLinkRequests');
    expect(settings).not.toContain('deviceLinkInvites');
    expect(settings).not.toContain('user-link-invite');
  });

  it('has no signed request-event transport or compatibility API', () => {
    const auth = fs.readFileSync(path.join(appRoot, 'src/nostr/auth.ts'), 'utf8');
    const barrel = fs.readFileSync(path.join(appRoot, 'src/nostr/index.ts'), 'utf8');
    const deviceLink = fs.readFileSync(path.join(appRoot, 'src/drive/deviceLink.ts'), 'utf8');
    const settings = fs.readFileSync(path.join(appRoot, 'src/components/settings/UserSettings.svelte'), 'utf8');
    const source = `${auth}\n${barrel}\n${deviceLink}\n${settings}`;

    for (const legacySymbol of [
      'linkDriveDevice',
      'createDriveDeviceLinkInvite',
      'signNostrIdentityDeviceLinkRequestEvent',
      'parseNostrIdentityDeviceLinkRequestEvent',
      'publishDriveDeviceLinkRequest',
      'subscribeDriveDeviceLinkRequests',
      'backfillDriveDeviceLinkRequestsForAdmin',
      'parseDriveDeviceLinkRequestEventForAdmin',
      'approveDriveDeviceLinkRequest',
      'activatePendingDriveDeviceLinkIfApproved',
      'pending_device_link',
      'pendingDeviceLink',
    ]) {
      expect(source).not.toContain(legacySymbol);
    }
  });
});
