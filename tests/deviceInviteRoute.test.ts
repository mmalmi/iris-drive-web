import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(__dirname, '..');

describe('device invite route', () => {
  it('routes drive.iris.to device invites to the link flow', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const route = fs.readFileSync(path.join(appRoot, 'src/routes/DeviceInviteRoute.svelte'), 'utf8');

    expect(router).toContain("{ pattern: '/invite/:payload', component: DeviceInviteRoute }");
    expect(router).toContain('<DeviceInviteRoute payload={route.params.payload || \'\'} />');
    expect(route).toContain('https://drive.iris.to/invite/');
    expect(route).toContain('<DriveSetup initialOwnerInput={inviteUrl} />');
  });

  it('keeps direct drive.iris.to device invite paths routable on first load', () => {
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(routerStore).toContain("pathname.startsWith('/invite/')");
    expect(routerStore).toContain('directPathIsRoutable(window.location.pathname)');
    expect(routerStore).toContain('return `${window.location.pathname}${window.location.search}`;');
  });

  it('routes scanned device approval requests to the approval flow', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const route = fs.readFileSync(path.join(appRoot, 'src/routes/DeviceApprovalRoute.svelte'), 'utf8');
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(router).toContain("{ pattern: '/approve-device/:payload', component: DeviceApprovalRoute }");
    expect(router).toContain('<DeviceApprovalRoute payload={route.params.payload || \'\'} />');
    expect(route).toContain('https://drive.iris.to/approve-device/');
    expect(route).toContain('approveDriveDeviceApprovalRequest');
    expect(routerStore).toContain("pathname.startsWith('/approve-device/')");
  });
});
