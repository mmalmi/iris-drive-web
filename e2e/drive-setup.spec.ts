import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
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

const profileId = '019ed693-4110-7352-8cc3-be90158ba91e';

function keypair(): { nsec: string; npub: string } {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkey),
  };
}

function inviteLink(adminAppKeyNpub: string): string {
  const inviteSecret = generateSecretKey();
  const payload = Buffer
    .from(JSON.stringify({
      v: 1,
      profileId,
      adminAppKeyNpub,
      inviteNpub: nip19.npubEncode(getPublicKey(inviteSecret)),
    }))
    .toString('base64url');
  return `https://drive.iris.to/invite/${payload}`;
}

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
    await expect(page.getByTestId('generate-new-account')).toHaveText(/Create new/);
    await expect(page.getByTestId('add-existing-profile')).toHaveText(/Add existing/);
    await page.getByTestId('generate-new-account').click();

    const npubHandle = await page.waitForFunction(() => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string; isLoggedIn?: boolean } };
      }).__nostrStore;
      return store?.getState?.().npub ?? null;
    }, undefined, { timeout: 30000 });
    await expectDriveRoute(page, await npubHandle.jsonValue());
  });

  test('recovers with secret key through the shared add-user flow', async ({ page, relayUrl }) => {
    const profile = await seedRecoverableProfile(relayUrl, generateSecretKey(), 'recovery_phrase');
    await openFreshSetup(page, relayUrl);

    await expect(page.getByTestId('generate-new-account')).toBeVisible();
    await expect(page.getByTestId('add-existing-profile')).toBeVisible();
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByTestId('identity-recovery-section')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link device' })).toBeVisible();
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Secret key' }).click();
    await page.locator('input[placeholder="nsec1..."]').fill(profile.recoveryNsec);
    await page.getByRole('button', { name: 'Continue' }).click();

    const recoveredNpubHandle = await page.waitForFunction((profileId: string) => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string; isLoggedIn?: boolean } };
      }).__nostrStore;
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      if (stored?.status === 'active' && stored?.profileId === profileId && store?.getState?.().npub) {
        return store.getState().npub;
      }
      return null;
    }, profile.profileId, { timeout: 30000 });
    const recoveredNpub = await recoveredNpubHandle.jsonValue() as string;
    await expectDriveRoute(page, recoveredNpub);
  });

  test('auto-opens the owner drive when a link-app npub is entered', async ({ page }) => {
    const owner = keypair();
    await openFreshSetup(page);

    await page.getByTestId('add-existing-profile').click();
    await page.getByRole('button', { name: 'Link device' }).click();
    await expect(page.getByLabel('Link device')).toBeVisible();

    await page.getByLabel('Link device').fill(owner.npub);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expectDriveRoute(page, owner.npub);
  });

  test('creates a pending linked-device session when an invite link is entered', async ({ page, relayUrl }) => {
    const admin = keypair();
    await openFreshSetup(page, relayUrl);

    await page.getByTestId('add-existing-profile').click();
    await page.getByRole('button', { name: 'Link device' }).click();

    await page.getByLabel('Link device').fill(inviteLink(admin.npub));
    await page.getByRole('button', { name: 'Continue' }).click();
    const linkedPubkeyHandle = await page.waitForFunction((expectedProfileId: string) => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string } };
      }).__nostrStore;
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      if (
        stored?.status === 'pending_device_link'
        && stored?.profileId === expectedProfileId
        && stored?.pendingDeviceLink?.adminAppKeyPubkey
        && store?.getState?.().isLoggedIn === false
      ) {
        return stored.pendingDeviceLink.deviceAppKeyPubkey;
      }
      return null;
    }, profileId);
    const linkedPubkey = await linkedPubkeyHandle.jsonValue() as string;

    const decodedAdmin = nip19.decode(admin.npub);
    expect(decodedAdmin.type).toBe('npub');
    expect(linkedPubkey).not.toBe(decodedAdmin.data);
    await expect(page).toHaveURL(/#\/settings\/user/);
    await expect(page.getByTestId('user-pending-link')).toBeVisible({ timeout: 30000 });
  });
});
