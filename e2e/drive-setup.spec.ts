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
  const payload = Buffer
    .from(JSON.stringify({
      v: 1,
      profileId,
      adminAppKeyNpub,
      linkSecret: 'drive-setup-e2e-secret',
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

  test('signs in with secret key recovery and keeps app linking under sign in', async ({ page, relayUrl }) => {
    const profile = await seedRecoverableProfile(relayUrl, generateSecretKey(), 'recovery_phrase');
    await openFreshSetup(page, relayUrl);

    await expect(page.getByRole('button', { name: 'Link this app' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Link this app' })).toBeVisible();
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);

    await page.getByLabel('Iris profile id').fill(profile.profileId);
    await page.getByRole('button', { name: 'Secret key' }).click();
    await page.locator('input[placeholder="nsec1..."]').fill(profile.recoveryNsec);
    await page.getByRole('button', { name: 'Recover app key' }).click();

    const recoveredNpubHandle = await page.waitForFunction((profileId: string) => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string } };
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

    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Link this app' }).click();
    await expect(page.getByLabel('Owner public key or invite link')).toBeVisible();

    await page.getByLabel('Owner public key or invite link').fill(owner.npub);
    await expectDriveRoute(page, owner.npub);
  });

  test('creates a pending linked-device session when an invite link is entered', async ({ page, relayUrl }) => {
    const admin = keypair();
    await openFreshSetup(page, relayUrl);

    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: 'Link this app' }).click();

    await page.getByLabel('Owner public key or invite link').fill(inviteLink(admin.npub));
    const linkedNpubHandle = await page.waitForFunction((expectedProfileId: string) => {
      const store = (window as unknown as {
        __nostrStore?: { getState?: () => { npub?: string } };
      }).__nostrStore;
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      if (
        stored?.status === 'pending_device_link'
        && stored?.profileId === expectedProfileId
        && stored?.pendingDeviceLink?.adminAppKeyPubkey
        && store?.getState?.().npub
      ) {
        return store.getState().npub;
      }
      return null;
    }, profileId);
    const linkedNpub = await linkedNpubHandle.jsonValue() as string;

    expect(linkedNpub).not.toBe(admin.npub);
    await expectDriveRoute(page, linkedNpub);
  });
});
