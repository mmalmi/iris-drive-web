import { generateSecretKey } from 'nostr-tools';
import { expect, test, type Page } from './fixtures';
import {
  clearAllStorage,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';
import { seedRecoverableProfile } from './identity-recovery-test-utils';

async function openFreshSetup(page: Page, relayUrl?: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/');
  await clearAllStorage(page);
  if (relayUrl) {
    await presetLocalRelayInDB(page, relayUrl);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  if (relayUrl) {
    await useLocalRelay(page, relayUrl);
    await waitForRelayConnected(page, 30000);
  }
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30000 });
}

async function expectDriveRoute(page: Page, scope: string): Promise<void> {
  await page.waitForFunction(
    (expectedHash: string) => window.location.hash === expectedHash,
    `#/${scope}/main`,
    { timeout: 30000 },
  );
}

test.describe('Drive setup', () => {
  test('creates a profile from the setup flow', async ({ page }) => {
    await openFreshSetup(page);

    await expect(page.getByRole('link', { name: 'Get native app' })).toHaveAttribute(
      'href',
      'https://irisdrive.iris.to/',
    );
    await expect(page.getByTestId('generate-new-account')).toHaveText(/Create Profile/);
    await expect(page.getByTestId('add-existing-profile')).toHaveText(/Sign in/);
    await page.getByTestId('generate-new-account').click();
    await expect(page).toHaveURL(/#\/users\/create/);
    await expect(page.getByTestId('identity-create-name')).toBeVisible();
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeDisabled();
    await page.getByTestId('identity-create-name').fill('Drive Test User');
    await page.getByTestId('create-new-after-recovery-miss').click();

    const profileIdHandle = await page.waitForFunction(() => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string; isLoggedIn?: boolean } };
      }).__nostrStore;
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      return stored?.status === 'active' && stored?.profileId && store?.getState?.().npub
        ? stored.profileId
        : null;
    }, undefined, { timeout: 30000 });
    await expectDriveRoute(page, await profileIdHandle.jsonValue());
  });

  test('recovers with secret key through the shared add-user flow', async ({ page, relayUrl }) => {
    const profile = await seedRecoverableProfile(relayUrl, generateSecretKey(), 'recovery_phrase');
    await openFreshSetup(page, relayUrl);

    await expect(page.getByTestId('generate-new-account')).toBeVisible();
    await expect(page.getByTestId('add-existing-profile')).toBeVisible();
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByTestId('identity-recovery-section')).toBeVisible();
    await expect(page.getByTestId('device-approval-request-section')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Request Link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Request Link' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Secret key' }).click();
    await page.locator('input[placeholder="nsec1..."]').fill(profile.recoveryNsec);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.waitForFunction((profileId: string) => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string; isLoggedIn?: boolean } };
      }).__nostrStore;
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      if (stored?.status === 'active' && stored?.profileId === profileId && store?.getState?.().npub) {
        return store.getState().npub;
      }
      return null;
    }, profile.profileId, { timeout: 30000 });
    await expectDriveRoute(page, profile.profileId);
  });

  test('shows request-link QR controls', async ({ page }) => {
    await openFreshSetup(page);

    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByRole('heading', { name: 'Request Link' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy Request Link' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('device-approval-qr')).toBeVisible({ timeout: 10000 });
  });

  test('creates a compact request-link QR from the add-existing setup flow', async ({ page }) => {
    await openFreshSetup(page);

    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByTestId('device-approval-request-section')).toBeVisible({ timeout: 30000 });

    const qrCode = page.getByTestId('device-approval-qr');
    await expect(qrCode).toBeVisible({ timeout: 10000 });
    await expect.poll(async () => qrCode.getAttribute('src'), { timeout: 10000 }).toMatch(/^data:image\/png;base64,/);
    const approvalState = await page.evaluate(() => {
      const approval = JSON.parse(localStorage.getItem('iris:drive:pending-device-approval') ?? 'null') as {
        url?: string;
        pendingApproval?: { request?: { deviceAppKeyPubkey?: string } };
      } | null;
      const session = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null') as { status?: string } | null;
      return {
        url: approval?.url ?? '',
        deviceAppKeyPubkey: approval?.pendingApproval?.request?.deviceAppKeyPubkey ?? '',
        sessionStatus: session?.status ?? '',
      };
    });
    expect(approvalState.url).toMatch(/^iris-drive:\/\/app-key-link\?app_key=[0-9a-f]{64}/);
    expect(approvalState.url.length).toBeLessThan(160);
    expect(approvalState.deviceAppKeyPubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalState.sessionStatus).not.toBe('pending_device_link');
  });
});
