import { expect, test } from './fixtures';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  cleanupVmSession,
  expectVmEntryKind,
  expectVmFile,
  expectVmFiles,
  expectVmMissing,
  missingVmEnv,
  setupVmSession,
  startVmDaemon,
  stopVmDaemon,
  stringArray,
  vmFipsStatus,
  vmProviderDelete,
  vmProviderMkdir,
  vmProviderRename,
  vmProviderWrite,
  vmStatus,
  vmSync,
  type DriveActor,
  type VmDaemonProcess,
  type WebDriveDevice,
} from './drive-vm-interop.vm';
import {
  authorizeWebDriveDevice,
  ensureBrowserDriveFipsStats,
  expectWebEntryKind,
  expectWebFile,
  expectWebMissing,
  newWebDriveDevice,
  restoreViaDriveSetup,
  startBrowserDriveFips,
  stopBrowserDriveFips,
  webDeleteAndPublish,
  webMkdirAndPublish,
  webRenameAndPublish,
  webWriteAndPublish,
} from './drive-vm-interop.web';
import {
  ensureWebMainRoot,
  expectVmContentsWithPrefix,
  mutateAndPublish,
  nativeReleaseOperationSequences,
  runManyFileBurst,
  withInteropSession,
} from './drive-vm-interop.scenarios';

test.describe('Iris Drive VM interop', () => {
  test.skip(missingVmEnv, 'set IRIS_DRIVE_VM_HOST, IRIS_DRIVE_VM_RELAY_URL, and IRIS_DRIVE_VM_BLOSSOM_URL to run VM interop');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(900000);

  test('drive web and one iris-drive VM exchange provider-style mutations', async ({ page }) => {
    const session = await setupVmSession();
    const webDeviceSecret = generateSecretKey();
    const webDevice: WebDriveDevice = {
      secret: webDeviceSecret,
      pubkey: getPublicKey(webDeviceSecret),
      seq: 0,
    };

    try {
      await restoreViaDriveSetup(page, session);
      await authorizeWebDriveDevice(page, session, webDevice);

      await vmProviderWrite(session, 'three-vm/vm.txt', 'from vm');
      await expectWebFile(page, 'three-vm/vm.txt', 'from vm');
      await vmProviderWrite(session, 'three-vm/vm.txt', 'from vm edited');
      await expectWebFile(page, 'three-vm/vm.txt', 'from vm edited');
      await vmProviderRename(session, 'three-vm/vm.txt', 'three-vm/vm-renamed.txt');
      await expectWebMissing(page, 'three-vm/vm.txt');
      await expectWebFile(page, 'three-vm/vm-renamed.txt', 'from vm edited');
      await vmProviderDelete(session, 'three-vm/vm-renamed.txt');
      await expectWebMissing(page, 'three-vm/vm-renamed.txt');

      await webWriteAndPublish(page, session, webDevice, 'three-vm/web.txt', 'from web');
      await expectVmFile(session, 'three-vm/web.txt', 'from web');
      await webWriteAndPublish(page, session, webDevice, 'three-vm/web.txt', 'from web edited');
      await expectVmFile(session, 'three-vm/web.txt', 'from web edited');
      await webRenameAndPublish(page, session, webDevice, 'three-vm/web.txt', 'three-vm/web-renamed.txt');
      await expectVmMissing(session, 'three-vm/web.txt');
      await expectVmFile(session, 'three-vm/web-renamed.txt', 'from web edited');
      await webDeleteAndPublish(page, session, webDevice, 'three-vm/web-renamed.txt');
      await expectVmMissing(session, 'three-vm/web-renamed.txt');

      await vmProviderMkdir(session, 'nested/vm-dir');
      await vmProviderWrite(session, 'nested/vm-dir/file.txt', 'nested from vm');
      await expectWebFile(page, 'nested/vm-dir/file.txt', 'nested from vm');
      await vmProviderDelete(session, 'nested/vm-dir');
      await expectWebMissing(page, 'nested/vm-dir/file.txt');

      await webWriteAndPublish(page, session, webDevice, 'nested/web-dir/file.txt', 'nested from web');
      await expectVmFile(session, 'nested/web-dir/file.txt', 'nested from web');
      await webDeleteAndPublish(page, session, webDevice, 'nested/web-dir');
      await expectVmMissing(session, 'nested/web-dir/file.txt');

      await vmProviderWrite(session, 'replace/vm-node', 'file before dir');
      await expectWebFile(page, 'replace/vm-node', 'file before dir');
      await vmProviderDelete(session, 'replace/vm-node');
      await expectWebMissing(page, 'replace/vm-node');
      await vmProviderMkdir(session, 'replace/vm-node');
      await expectWebEntryKind(page, 'replace/vm-node', 'directory');
      await vmProviderDelete(session, 'replace/vm-node');
      await expectWebMissing(page, 'replace/vm-node');
      await vmProviderWrite(session, 'replace/vm-node', 'file after dir');
      await expectWebFile(page, 'replace/vm-node', 'file after dir');

      await webWriteAndPublish(page, session, webDevice, 'replace/web-node', 'web file before dir');
      await expectVmFile(session, 'replace/web-node', 'web file before dir');
      await webDeleteAndPublish(page, session, webDevice, 'replace/web-node');
      await expectVmMissing(session, 'replace/web-node');
      await webMkdirAndPublish(page, session, webDevice, 'replace/web-node');
      await expectVmEntryKind(session, 'replace/web-node', 'directory');
      await webDeleteAndPublish(page, session, webDevice, 'replace/web-node');
      await expectVmMissing(session, 'replace/web-node');
      await webWriteAndPublish(page, session, webDevice, 'replace/web-node', 'web file after dir');
      await expectVmFile(session, 'replace/web-node', 'web file after dir');

      await vmProviderWrite(session, 'rename-chain/vm-a.txt', 'vm rename chain');
      await vmProviderRename(session, 'rename-chain/vm-a.txt', 'rename-chain/vm-b.txt');
      await vmProviderRename(session, 'rename-chain/vm-b.txt', 'rename-chain/vm-c.txt');
      await expectWebMissing(page, 'rename-chain/vm-a.txt');
      await expectWebMissing(page, 'rename-chain/vm-b.txt');
      await expectWebFile(page, 'rename-chain/vm-c.txt', 'vm rename chain');

      await webWriteAndPublish(page, session, webDevice, 'rename-chain/web-a.txt', 'web rename chain');
      await webRenameAndPublish(page, session, webDevice, 'rename-chain/web-a.txt', 'rename-chain/web-b.txt');
      await webRenameAndPublish(page, session, webDevice, 'rename-chain/web-b.txt', 'rename-chain/web-c.txt');
      await expectVmMissing(session, 'rename-chain/web-a.txt');
      await expectVmMissing(session, 'rename-chain/web-b.txt');
      await expectVmFile(session, 'rename-chain/web-c.txt', 'web rename chain');
    } finally {
      cleanupVmSession(session);
    }
  });

  test('browser FIPS WebRTC discovers and connects to the native iris-drive daemon', async ({ page }) => {
    const session = await setupVmSession();
    const webDevice = newWebDriveDevice();
    const webDeviceNpub = nip19.npubEncode(webDevice.pubkey);
    let daemon: VmDaemonProcess | null = null;

    try {
      await restoreViaDriveSetup(page, session);
      await authorizeWebDriveDevice(page, session, webDevice);
      await ensureWebMainRoot({ page, session, webDevice });
      await vmSync(session);

      await expect.poll(() => vmStatus(session).network, {
        timeout: 120000,
        intervals: [1000, 2000, 3000, 5000],
      }).toMatchObject({ authorized_device_count: 2 });

      daemon = startVmDaemon(session);

      await expect.poll(() => {
        const fips = vmFipsStatus(session);
        return {
          running: fips.running === true,
          enabled: fips.enabled === true,
          webrtcEnabled: fips.webrtc_enabled === true,
          discoveryScope: fips.discovery_scope,
          authorized: stringArray(fips.authorized_peers).includes(webDeviceNpub),
          connectedPeerCount: Number(fips.connected_peer_count ?? 0),
        };
      }, {
        timeout: 120000,
        intervals: [1000, 2000, 3000, 5000],
      }).toMatchObject({
        running: true,
        enabled: true,
        webrtcEnabled: true,
        discoveryScope: `iris-drive:${session.profileId}`,
        authorized: true,
      });

      const initialStats = await startBrowserDriveFips(page, session, webDevice);
      expect(initialStats.localXOnlyPubkey).toBe(webDevice.pubkey);
      expect(initialStats.discoveryScope).toBe(`iris-drive:${session.profileId}`);

      await expect.poll(async () => {
        const stats = await ensureBrowserDriveFipsStats(page, session, webDevice);
        const connectedPeerIds = stats?.connectedPeerIds ?? [];
        return {
          active: stats?.active === true,
          connectedToNative: connectedPeerIds.some((peerId) => peerId.slice(2) === session.devicePubkey),
          connectedPeerIds,
        };
      }, {
        timeout: 180000,
        intervals: [1000, 2000, 3000, 5000],
      }).toMatchObject({
        active: true,
        connectedToNative: true,
      });

      await expect.poll(() => {
        const fips = vmFipsStatus(session);
        return {
          connectedToWeb: stringArray(fips.connected_peers).includes(webDeviceNpub),
          connectedPeers: stringArray(fips.connected_peers),
          connectedPeerCount: Number(fips.connected_peer_count ?? 0),
        };
      }, {
        timeout: 180000,
        intervals: [1000, 2000, 3000, 5000],
      }).toMatchObject({
        connectedToWeb: true,
      });
    } finally {
      await stopBrowserDriveFips(page);
      stopVmDaemon(session, daemon);
      cleanupVmSession(session);
    }
  });

  for (const sequence of nativeReleaseOperationSequences) {
    for (const source of ['web', 'vm'] satisfies DriveActor[]) {
      test(`matches native release ${sequence.name} from ${source} root`, async ({ page }) => {
        await withInteropSession(page, async (ctx) => {
          await sequence.run(ctx, source, `release/${sequence.name}/${source}`);
        });
      });
    }
  }

  test('merges independent web and VM roots and keeps conflict copies in the native view', async ({ page }) => {
    await withInteropSession(page, async (ctx) => {
      await mutateAndPublish(ctx, 'web', [
        { type: 'write', path: 'initial/web-only.txt', content: 'web only' },
        { type: 'write', path: 'initial/same.txt', content: 'same bytes' },
        { type: 'write', path: 'initial/unicode/Raksmorgas-动作-Адрес.txt', content: 'unicode path bytes' },
        { type: 'write', path: 'initial/conflict.txt', content: 'web conflict' },
      ]);
      await mutateAndPublish(ctx, 'vm', [
        { type: 'write', path: 'initial/vm-only.txt', content: 'vm only' },
        { type: 'write', path: 'initial/same.txt', content: 'same bytes' },
        { type: 'write', path: 'initial/conflict.txt', content: 'vm conflict' },
      ]);

      await expectVmFiles(ctx.session, {
        'initial/web-only.txt': 'web only',
        'initial/vm-only.txt': 'vm only',
        'initial/same.txt': 'same bytes',
        'initial/unicode/Raksmorgas-动作-Адрес.txt': 'unicode path bytes',
      });
      await expectVmContentsWithPrefix(ctx.session, 'initial/conflict', ['vm conflict', 'web conflict']);
    });
  });

  test('preserves a concurrent native edit versus web delete as a conflict copy', async ({ page }) => {
    await withInteropSession(page, async (ctx) => {
      const path = 'conflicts/edit-delete.txt';
      await vmProviderWrite(ctx.session, path, 'baseline before edit-delete');
      await expectWebFile(ctx.page, path, 'baseline before edit-delete');

      await vmProviderWrite(ctx.session, path, 'vm edited while web deleted');
      await mutateAndPublish(ctx, 'web', [{ type: 'delete', path }]);

      await expectVmMissing(ctx.session, path);
      await expectVmContentsWithPrefix(ctx.session, 'conflicts/edit-delete', ['vm edited while web deleted']);
    });
  });

  test('catches up bursty many-file web changes on the VM', async ({ page }) => {
    const count = Number.parseInt(process.env.IRIS_DRIVE_VM_STRESS_FILES ?? '16', 10);
    const requestedBatchSize = Number.parseInt(process.env.IRIS_DRIVE_VM_STRESS_BATCH ?? '16', 10);
    const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0 ? requestedBatchSize : 16;
    await withInteropSession(page, async (ctx) => {
      await runManyFileBurst(ctx, 'web', 'stress/web', count, batchSize);
    });
  });

  test('catches up bursty many-file VM changes on the web app', async ({ page }) => {
    const count = Number.parseInt(process.env.IRIS_DRIVE_VM_STRESS_FILES ?? '16', 10);
    const requestedBatchSize = Number.parseInt(process.env.IRIS_DRIVE_VM_STRESS_BATCH ?? '16', 10);
    const batchSize = Number.isFinite(requestedBatchSize) && requestedBatchSize > 0 ? requestedBatchSize : 16;
    await withInteropSession(page, async (ctx) => {
      await runManyFileBurst(ctx, 'vm', 'stress/vm', count, batchSize);
    });
  });
});
