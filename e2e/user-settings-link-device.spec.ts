import { expect, test, type Browser, type Page } from './fixtures';
import {
  clearAllStorage,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
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
  await waitForRelayConnected(page, 30000);
}

async function createAdminDriveUser(page: Page): Promise<string> {
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('heading', { name: 'Create profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Create profile' }).click();

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

async function createLinkInvite(page: Page): Promise<string> {
  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-key-row')).toHaveCount(1, { timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-key-row')).toHaveCount(1, { timeout: 30000 });
  await page.getByTestId('user-add-device-toggle').click();
  await expect(page.getByTestId('user-add-device-panel')).toBeVisible();
  await expect(page.getByTestId('user-create-link')).toHaveCount(0);
  const invite = page.getByTestId('user-link-invite').locator('.copy-value');
  await expect(invite).toContainText('https://drive.iris.to/invite/', { timeout: 10000 });
  const qrCode = page.getByTestId('user-link-invite-qr');
  await expect(qrCode).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => qrCode.getAttribute('src'), { timeout: 10000 }).toMatch(/^data:image\/png;base64,/);
  return (await invite.textContent())?.trim() ?? '';
}

async function linkDeviceFromUsers(page: Page, invite: string): Promise<void> {
  await page.goto('/#/users', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('add-existing-profile')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('add-existing-profile').click();
  await expect(page).toHaveURL(/#\/users\/existing/);
  await page.getByRole('button', { name: 'Link device' }).click();
  await page.getByLabel('Link device').fill(invite);
  await page.getByRole('button', { name: 'Recover app key' }).click();

  await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.status === 'pending_device_link'
      && stored?.pendingDeviceLink?.deviceAppKeyPubkey
      && window.location.hash.includes('/main');
  }, undefined, { timeout: 30000 });
}

async function expectPendingRequestVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('user-link-request')).toBeVisible({ timeout: 30000 });
}

async function expectPendingRequestAndApprove(page: Page): Promise<void> {
  await expectPendingRequestVisible(page);
  await page.getByTestId('user-approve-link').click();
  await expect(page.getByTestId('user-link-request')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30000 });
}

async function reloadOwnerSettingsWithInvite(page: Page, invite: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-link-request')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-link-invite').locator('.copy-value')).toContainText(invite, { timeout: 10000 });
  await expect(page.getByTestId('user-link-invite-qr')).toBeVisible({ timeout: 10000 });
}

async function activateApprovedDevice(page: Page, profileId: string): Promise<void> {
  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('user-pending-link')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('user-check-approval').click();
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30000 });

  await expect.poll(async () => page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return {
      profileId: stored?.profileId,
      status: stored?.status,
    };
  }), { timeout: 30000 }).toEqual({
    profileId,
    status: 'active',
  });
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
    } finally {
      await deviceContext.close();
    }
  });
});
