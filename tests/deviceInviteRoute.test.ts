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
    expect(route).toContain('approveDriveDeviceApprovalRequest');
    expect(routerStore).toContain("pathname.startsWith('/approve-device/')");
  });

  it('does not expose the old invite route', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(router).not.toContain('DeviceInviteRoute');
    expect(router).not.toContain("'/invite/:payload'");
    expect(routerStore).not.toContain("pathname.startsWith('/invite/')");
  });
});
