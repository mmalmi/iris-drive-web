import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { expect, test, type Page } from './fixtures';
import { clearAllStorage, setupPageErrorHandler, waitForAppReady } from './test-utils';

function keypair(): { nsec: string; npub: string } {
  const secret = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(getPublicKey(secret)),
  };
}

function inviteLink(ownerNpub: string, adminDeviceNpub: string): string {
  const payload = Buffer
    .from(JSON.stringify({
      v: 1,
      ownerNpub,
      adminDeviceNpub,
      linkSecret: 'drive-setup-e2e-secret',
    }))
    .toString('base64url');
  return `https://drive.iris.to/invite/${payload}`;
}

async function openFreshSetup(page: Page): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/');
  await clearAllStorage(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30000 });
}

async function expectDriveRoute(page: Page, npub: string): Promise<void> {
  await page.waitForFunction(
    (expectedHash: string) => window.location.hash === expectedHash,
    `#/${npub}/main`,
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
    await page.getByRole('button', { name: 'Create profile' }).click();
    await expect(page.getByRole('heading', { name: 'Create profile' })).toBeVisible();
    await page.getByRole('button', { name: 'Create profile' }).click();

    const npubHandle = await page.waitForFunction(() => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string } };
      }).__nostrStore;
      return store?.getState?.().npub ?? null;
    }, undefined, { timeout: 30000 });
    await expectDriveRoute(page, await npubHandle.jsonValue());
  });

  test('signs in with a secret key and keeps app linking under sign in', async ({ page }) => {
    const owner = keypair();
    await openFreshSetup(page);

    await expect(page.getByRole('button', { name: 'Link this app' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Secret key')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link this app' })).toBeVisible();

    await page.getByLabel('Secret key').fill(owner.nsec);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expectDriveRoute(page, owner.npub);
  });

  test('auto-opens the owner drive when a link-app npub is entered', async ({ page }) => {
    const owner = keypair();
    await openFreshSetup(page);

    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Link this app' }).click();
    await expect(page.getByLabel('Owner public key or invite link')).toBeVisible();

    await page.getByLabel('Owner public key or invite link').fill(owner.npub);
    await expectDriveRoute(page, owner.npub);
  });

  test('auto-opens the owner drive when an invite link is entered', async ({ page }) => {
    const owner = keypair();
    const admin = keypair();
    await openFreshSetup(page);

    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Link this app' }).click();

    await page.getByLabel('Owner public key or invite link').fill(inviteLink(owner.npub, admin.npub));
    await expectDriveRoute(page, owner.npub);
  });
});
