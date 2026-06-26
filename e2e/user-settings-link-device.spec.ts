import { expect, test, type Browser, type Page } from './fixtures';
import {
  addFileViaTreeAPI,
  clearAllStorage,
  configureBlossomServers,
  enableOthersPool,
  flushPendingPublishes,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForCurrentDirectoryEntries,
  waitForWebRTCConnection,
  waitForRelayConnected,
} from './test-utils.js';

async function prepareDriveInstance(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30000);
}

async function createAdminDriveUser(page: Page): Promise<string> {
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('generate-new-account').click();

  const profileIdHandle = await page.waitForFunction(() => {
    const session = (window as unknown as {
      __nostrStore?: { getState?: () => { npub?: string } };
    });
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.status === 'active' && stored?.profileId && session.__nostrStore?.getState?.().npub
      ? stored.profileId
      : null;
  }, undefined, { timeout: 30000 });
  const profileId = await profileIdHandle.jsonValue() as string;
  await page.waitForFunction(() => window.location.hash.includes('/main'), undefined, { timeout: 30000 });
  return profileId;
}

async function readStoredDeviceLinkInviteUrl(page: Page): Promise<string> {
  return page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('iris:drive:device-link-invites') ?? '{}') as Record<string, { url?: string }>;
    return Object.values(all).find((invite) => invite.url?.startsWith('https://drive.iris.to/invite/'))?.url ?? '';
  });
}

async function expectDeviceAdminBadges(page: Page, expectedRows: number, expectedAdmins: number): Promise<void> {
  const rows = page.getByTestId('user-key-row');
  const keyList = page.getByTestId('user-settings-keys');
  const statuses = page.getByTestId('user-key-status');
  await expect(rows).toHaveCount(expectedRows, { timeout: 30000 });
  await expect(keyList.locator('.badge')).toHaveCount(expectedAdmins);
  if (expectedAdmins > 0) {
    await expect(keyList.locator('.badge')).toHaveText(Array.from({ length: expectedAdmins }, () => 'Admin'));
  }
  await expect(statuses).toHaveCount(expectedRows);
  await expect(statuses.nth(0)).toHaveAttribute('data-device-status', 'online');
  await expect(keyList).not.toContainText('Online');
  await expect(keyList).not.toContainText('Offline');
  await expect(keyList).not.toContainText('Current');
  await expect(keyList).not.toContainText('Write');
  await expect(keyList).not.toContainText('Recovery');
  await expect(keyList).not.toContainText('Decrypt');
  await expect(keyList).not.toContainText('Receive keys');
}

async function expectDeviceLabels(page: Page, labels: string[]): Promise<void> {
  const rows = page.getByTestId('user-key-row');
  await expect(rows).toHaveCount(labels.length, { timeout: 30000 });
  for (const [index, label] of labels.entries()) {
    await expect(rows.nth(index).locator('strong')).toHaveText(label);
  }
}

async function expectLinkedDeviceLabel(page: Page): Promise<void> {
  const remoteLabel = page.getByTestId('user-key-row').nth(1).locator('strong');
  await expect(remoteLabel).not.toHaveText('This device');
  await expect(remoteLabel).not.toHaveText('Device');
  await expect(remoteLabel).toHaveText(/.+/);
}

async function createLinkInvite(page: Page): Promise<string> {
  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-settings-summary')).toHaveCount(0);
  await expect(page.getByTestId('user-settings-devices').getByRole('heading', { name: 'Devices' })).toHaveCount(0);
  await expectDeviceAdminBadges(page, 1, 1);
  await expectDeviceLabels(page, ['This device']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-settings-summary')).toHaveCount(0);
  await expect(page.getByTestId('user-settings-devices').getByRole('heading', { name: 'Devices' })).toHaveCount(0);
  await expectDeviceAdminBadges(page, 1, 1);
  await expectDeviceLabels(page, ['This device']);
  await page.getByTestId('user-add-device-toggle').click();
  await expect(page.getByTestId('user-add-device-panel')).toBeVisible();
  await expect(page.getByTestId('user-create-link')).toHaveCount(0);
  await expect(page.getByTestId('user-link-invite')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('user-copy-link')).toContainText('Copy link');
  await expect(page.getByTestId('user-settings-panel')).not.toContainText('https://drive.iris.to/invite/');
  const qrCode = page.getByTestId('user-link-invite-qr');
  await expect(qrCode).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => qrCode.getAttribute('src'), { timeout: 10000 }).toMatch(/^data:image\/png;base64,/);
  await expect.poll(() => readStoredDeviceLinkInviteUrl(page), { timeout: 10000 }).toMatch(/^https:\/\/drive\.iris\.to\/invite\//);
  const firstInvite = await readStoredDeviceLinkInviteUrl(page);
  await expect(page.getByTestId('user-reset-link')).toContainText('Reset link');
  await page.getByTestId('user-reset-link').click();
  await expect.poll(() => readStoredDeviceLinkInviteUrl(page), { timeout: 10000 }).not.toBe(firstInvite);
  await expect.poll(() => readStoredDeviceLinkInviteUrl(page), { timeout: 10000 }).toMatch(/^https:\/\/drive\.iris\.to\/invite\//);
  await expect(page.getByTestId('user-link-invite-qr')).toBeVisible({ timeout: 10000 });
  return readStoredDeviceLinkInviteUrl(page);
}

async function linkDeviceFromUsers(page: Page, invite: string): Promise<void> {
  await page.goto('/#/users', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('add-existing-profile')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('add-existing-profile').click();
  await expect(page).toHaveURL(/#\/users\/existing/);
  await page.getByRole('button', { name: 'Link device' }).click();
  await page.getByLabel('Link device').fill(invite);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.status === 'pending_device_link'
      && stored?.pendingDeviceLink?.deviceAppKeyPubkey
      && window.location.hash.includes('/settings/user');
  }, undefined, { timeout: 30000 });
  await expect(page.getByTestId('user-pending-link')).toBeVisible({ timeout: 30000 });
}

async function expectPendingRequestVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('user-link-request')).toBeVisible({ timeout: 30000 });
}

async function expectPendingRequestAndApprove(page: Page): Promise<void> {
  await expectPendingRequestVisible(page);
  await page.getByTestId('user-approve-link').click();
  await expect(page.getByTestId('user-link-request')).toHaveCount(0, { timeout: 30000 });
  await expectDeviceAdminBadges(page, 2, 1);
  await expect(page.getByTestId('user-key-row').nth(0).locator('strong')).toHaveText('This device');
  await expectLinkedDeviceLabel(page);
  await expect(page.getByTestId('user-key-row').nth(1).getByTestId('user-grant-admin')).toBeVisible();
  await expect(page.getByTestId('user-key-row').nth(1).getByTestId('user-revoke-admin')).toHaveCount(0);
}

async function reloadOwnerSettingsWithInvite(page: Page, invite: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-settings-summary')).toHaveCount(0);
  await expect(page.getByTestId('user-link-request')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-copy-link')).toContainText('Copy link');
  await expect(page.getByTestId('user-reset-link')).toContainText('Reset link');
  await expect(page.getByTestId('user-settings-panel')).not.toContainText(invite);
  await expect.poll(() => readStoredDeviceLinkInviteUrl(page), { timeout: 10000 }).toBe(invite);
  await expect(page.getByTestId('user-link-invite-qr')).toBeVisible({ timeout: 10000 });
}

async function activateApprovedDevice(page: Page, profileId: string): Promise<void> {
  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expectDeviceAdminBadges(page, 2, 1);
  await expect(page.getByTestId('user-key-row').nth(0).locator('strong')).toHaveText('This device');
  await expectLinkedDeviceLabel(page);

  await expect.poll(async () => page.evaluate(async () => {
    const { getCurrentIrisIdentitySession } = await import('/src/nostr');
    const session = getCurrentIrisIdentitySession();
    const pubkey = (window as any).__nostrStore?.getState?.().pubkey;
    return {
      profileId: session?.profileId,
      status: session?.status,
      liveMatchesStoredAppKey: !!session?.appKeyPubkey && pubkey === session.appKeyPubkey,
    };
  }), { timeout: 30000 }).toEqual({
    profileId,
    status: 'active',
    liveMatchesStoredAppKey: true,
  });
}

async function appKeyPubkey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.appKeyPubkey ?? '';
  });
}

async function pushCurrentProfileRootToBlossom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { getTreeRootSync } = await import('/src/stores');
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    if (!profileId) throw new Error('No active Drive profile id');
    const root = getTreeRootSync(profileId, 'main');
    if (!root?.hash) throw new Error('No current profile root');
    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (!adapter?.pushToBlossom) throw new Error('Worker adapter has no pushToBlossom');
    const result = await adapter.pushToBlossom(root.hash, root.key, 'main');
    if (result.failed > 0) {
      throw new Error(`Blossom push failed: ${JSON.stringify(result)}`);
    }
  });
}

async function gotoMain(page: Page): Promise<void> {
  const profileId = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.profileId ?? '';
  });
  expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto(`/#/${profileId}/main`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-testid="file-list"]').first()).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.evaluate(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    return !!getCurrentRootCid()?.hash;
  }), { timeout: 30000, intervals: [500, 1000, 2000] }).toBe(true);
}

async function writeMainFileAndPublish(page: Page, filename: string, content: string): Promise<void> {
  const root = await addFileViaTreeAPI(page, [], filename, content);
  expect(root).toBeTruthy();
  await flushPendingPublishes(page);
  await pushCurrentProfileRootToBlossom(page);
}

async function readMainFileContent(page: Page, filename: string): Promise<string | null> {
  return page.evaluate(async (target: string) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const rootCid = getCurrentRootCid();
    if (!rootCid) return null;
    const entry = await getTree().resolvePath(rootCid, [target]).catch(() => null);
    if (!entry?.cid || entry.type === LinkType.Dir) return null;
    const bytes = await getTree().readFile(entry.cid).catch(() => null);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, filename);
}

async function profileDriveRootDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const { getTreeRootSync } = await import('/src/stores');
    const { driveRootDTag, KIND_DRIVE_ROOT, parseDriveRootEventForDevice, parseDriveRootEventPreview } = await import('/src/drive/protocol');
    const { getSecretKey, ndk } = await import('/src/nostr');
    const { treeRootRegistry } = await import('/src/TreeRootRegistry');
    const toHex = (bytes?: Uint8Array): string | undefined => bytes
      ? Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
      : undefined;
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    const driveId = 'main';
    const key = `${profileId}/${driveId}`;
    const secretKey = getSecretKey();
    const record = treeRootRegistry.getByKey(key);
    const currentRoot = getTreeRootSync(profileId, driveId);
    const events = profileId
      ? Array.from(await ndk.fetchEvents({
        kinds: [KIND_DRIVE_ROOT],
        '#d': [driveRootDTag(profileId, driveId)],
        limit: 20,
      }))
      : [];
    return {
      profileId,
      appKeyPubkey: stored?.appKeyPubkey,
      rosterOps: stored?.rosterOps?.length ?? 0,
      registry: record ? {
        hash: toHex(record.hash),
        key: toHex(record.key),
        updatedAt: record.updatedAt,
        dirty: record.dirty,
        source: record.source,
      } : null,
      currentRoot: currentRoot ? {
        hash: toHex(currentRoot.hash),
        key: toHex(currentRoot.key),
      } : null,
      events: events.map((event) => {
        const raw = event.rawEvent();
        let preview: unknown = null;
        let readable: unknown = null;
        try {
          preview = parseDriveRootEventPreview(raw);
        } catch (error) {
          preview = String(error);
        }
        if (secretKey) {
          try {
            const parsed = parseDriveRootEventForDevice(raw, secretKey);
            readable = {
              hash: toHex(parsed.root.hash),
              hasKey: !!parsed.root.key,
            };
          } catch (error) {
            readable = String(error);
          }
        }
        return {
          id: raw.id,
          pubkey: raw.pubkey,
          created_at: raw.created_at,
          preview,
          readable,
        };
      }),
    };
  });
}

async function expectMainFileContent(page: Page, filename: string, expected: string): Promise<void> {
  try {
    await expect.poll(
      () => readMainFileContent(page, filename),
      { timeout: 60000, intervals: [1000, 2000, 3000] },
    ).toBe(expected);
    await waitForCurrentDirectoryEntries(page, [filename], 10000);
  } catch (error) {
    const diagnostics = await profileDriveRootDiagnostics(page).catch((diagnosticError) => ({
      diagnosticError: String(diagnosticError),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function expectLinkedBrowsersCanExchangeEdits(owner: Page, linked: Page): Promise<void> {
  await gotoMain(owner);
  await gotoMain(linked);
  await enableOthersPool(owner, 6);
  await enableOthersPool(linked, 6);
  const ownerKey = await appKeyPubkey(owner);
  const linkedKey = await appKeyPubkey(linked);
  await waitForWebRTCConnection(owner, 30000, linkedKey);
  await waitForWebRTCConnection(linked, 30000, ownerKey);

  await writeMainFileAndPublish(linked, 'linked-browser-edit.txt', 'from linked browser');
  await gotoMain(owner);
  await expectMainFileContent(owner, 'linked-browser-edit.txt', 'from linked browser');

  await writeMainFileAndPublish(owner, 'owner-browser-edit.txt', 'from owner browser');
  await gotoMain(linked);
  await expectMainFileContent(linked, 'owner-browser-edit.txt', 'from owner browser');
}

test.describe('Drive user settings link device', () => {
  test('links an existing Drive user through another approving Drive instance', async ({ page, browser, relayUrl }) => {
    test.setTimeout(120000);
    await prepareDriveInstance(page, relayUrl);
    const profileId = await createAdminDriveUser(page);
    const invite = await createLinkInvite(page);
    expect(invite).toMatch(/^https:\/\/drive\.iris\.to\/invite\//);

    const deviceContext = await (browser as Browser).newContext();
    const devicePage = await deviceContext.newPage();
    try {
      await prepareDriveInstance(devicePage, relayUrl);
      await linkDeviceFromUsers(devicePage, invite);
      await expectPendingRequestVisible(page);
      await reloadOwnerSettingsWithInvite(page, invite);
      await expectPendingRequestAndApprove(page);
      await activateApprovedDevice(devicePage, profileId);
      await expectLinkedBrowsersCanExchangeEdits(page, devicePage);
    } finally {
      await deviceContext.close();
    }
  });
});
