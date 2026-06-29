import { expect, test, type Page } from './fixtures';
import {
  clearAllStorage,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils.js';
// Playwright's Node process needs NDK's built JS; the package export points at TS source for Vite.
import NDK, { NDKNip46Backend, NDKPrivateKeySigner } from '../node_modules/ndk/dist/index.js';
import { generateSecretKey, getPublicKey, nip19, nip44, type Event } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import type { NostrIdentityKeyPurpose } from '../src/drive/protocol';
import {
  seedRecoverableProfile,
  signWithRecoverySecret,
  type RecoveryProfile,
} from './identity-recovery-test-utils';

const SEED_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type RecoveryRunOptions = {
  purpose: NostrIdentityKeyPurpose;
  beforePage?: (page: Page, profile: RecoveryProfile, relayUrl: string) => Promise<(() => void) | void>;
  exercise: (page: Page, profile: RecoveryProfile, relayUrl: string) => Promise<void>;
};

async function prepareRecoveryPage(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await presetLocalRelayInDB(page, relayUrl);
  await page.goto('/#/users/existing', { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  await useLocalRelay(page, relayUrl);
  await waitForRelayConnected(page, 30000);
  await expect(page.getByTestId('identity-recovery-section')).toBeVisible();
}

async function assertRecovered(page: Page, profile: RecoveryProfile): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`#/${profile.profileId}/main`), { timeout: 30000 });
  await page.waitForFunction((profileId) => {
    const accounts = JSON.parse(localStorage.getItem('hashtree:accounts') ?? '[]');
    const activePubkey = localStorage.getItem('hashtree:activeAccount');
    const session = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return session?.profileId === profileId
      && accounts.some((account: {
        pubkey?: string;
        type?: string;
        nostrIdentityId?: string;
        nsec?: string;
      }) => account.pubkey === activePubkey
        && account.type === 'drive_profile'
        && account.nostrIdentityId === profileId
        && typeof account.nsec === 'string'
        && account.nsec.startsWith('nsec1'));
  }, profile.profileId, { timeout: 10000 });
}

async function runRecoveryLogin(
  page: Page,
  relayUrl: string,
  recoverySecretKey: Uint8Array,
  options: RecoveryRunOptions,
): Promise<void> {
  const profile = await seedRecoverableProfile(relayUrl, recoverySecretKey, options.purpose);
  const cleanup = await options.beforePage?.(page, profile, relayUrl);
  try {
    await prepareRecoveryPage(page, relayUrl);
    await options.exercise(page, profile, relayUrl);
    await assertRecovered(page, profile);
  } finally {
    cleanup?.();
  }
}

async function installNip07Extension(page: Page, profile: RecoveryProfile): Promise<void> {
  await page.exposeFunction('__irisTestNip07SignEvent', (draft: Event) => signWithRecoverySecret(profile, draft));
  await page.exposeFunction('__irisTestNip07Encrypt', (recipientPubkey: string, plaintext: string) => (
    nip44.v2.encrypt(
      plaintext,
      nip44.v2.utils.getConversationKey(profile.recoverySecretKey, recipientPubkey),
    )
  ));
  await page.exposeFunction('__irisTestNip07Decrypt', (senderPubkey: string, ciphertext: string) => (
    nip44.v2.decrypt(
      ciphertext,
      nip44.v2.utils.getConversationKey(profile.recoverySecretKey, senderPubkey),
    )
  ));
  await page.addInitScript((pubkey) => {
    const win = window as typeof window & {
      __irisTestNip07SignEvent: (draft: Event) => Promise<Event>;
      __irisTestNip07Encrypt: (recipientPubkey: string, plaintext: string) => Promise<string>;
      __irisTestNip07Decrypt: (senderPubkey: string, ciphertext: string) => Promise<string>;
    };
    window.nostr = {
      getPublicKey: async () => pubkey,
      signEvent: (draft) => win.__irisTestNip07SignEvent(draft as Event),
      nip44: {
        encrypt: (recipientPubkey, plaintext) => win.__irisTestNip07Encrypt(recipientPubkey, plaintext),
        decrypt: (senderPubkey, ciphertext) => win.__irisTestNip07Decrypt(senderPubkey, ciphertext),
      },
    };
  }, profile.recoveryPubkey);
}

async function startNip46Backend(
  _page: Page,
  profile: RecoveryProfile,
  relayUrl: string,
): Promise<() => void> {
  const ndk = new NDK({ explicitRelayUrls: [relayUrl] });
  await ndk.connect(5000);
  const backend = new NDKNip46Backend(
    ndk,
    new NDKPrivateKeySigner(profile.recoveryNsec),
    async () => true,
    [relayUrl],
  );
  await backend.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return () => {
    for (const relay of ndk.pool.relays.values()) {
      relay.disconnect();
    }
  };
}

test.describe('Users Page recovery login', () => {
  test('logs in with Secret key recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, generateSecretKey(), {
      purpose: 'recovery_phrase',
      exercise: async (targetPage, profile) => {
        await targetPage.getByRole('button', { name: 'Secret key' }).click();
        await targetPage.locator('input[placeholder="nsec1..."]').fill(profile.recoveryNsec);
        await targetPage.getByRole('button', { name: 'Continue' }).click();
      },
    });
  });

  test('logs in with Seed phrase recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, privateKeyFromSeedWords(SEED_WORDS), {
      purpose: 'recovery_phrase',
      exercise: async (targetPage) => {
        await targetPage.getByRole('button', { name: 'Seed phrase' }).click();
        await targetPage.getByLabel('Seed phrase').fill(SEED_WORDS);
        await targetPage.getByRole('button', { name: 'Continue' }).click();
      },
    });
  });

  test('logs in with Browser extension recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, generateSecretKey(), {
      purpose: 'nip46_signer',
      beforePage: installNip07Extension,
      exercise: async (targetPage) => {
        await expect(targetPage.getByRole('button', { name: 'Browser extension' })).toBeVisible();
        await targetPage.getByRole('button', { name: 'Browser extension' }).click();
        await expect(targetPage.getByRole('button', { name: 'Continue' })).toHaveCount(0);
      },
    });
  });

  test('offers Create new when Browser extension has no Drive user', async ({ page, relayUrl }) => {
    const recoverySecretKey = generateSecretKey();
    const profile: RecoveryProfile = {
      profileId: crypto.randomUUID(),
      recoverySecretKey,
      recoveryPubkey: getPublicKey(recoverySecretKey),
      recoveryNsec: nip19.nsecEncode(recoverySecretKey),
    };

    await installNip07Extension(page, profile);
    await prepareRecoveryPage(page, relayUrl);
    await page.getByRole('button', { name: 'Browser extension' }).click();
    await expect(page).toHaveURL(/#\/users\/no_existing/, { timeout: 30000 });
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
    await expect(page.getByTestId('identity-recovery-create-new-view')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('No existing Drive user found for that key')).toBeVisible();
    await expect(page.getByTestId('identity-create-name')).toBeVisible();
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeVisible();
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Browser extension' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Seed phrase' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Link device' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Secret key' })).toHaveCount(0);
  });

  test('logs in with Link device recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, generateSecretKey(), {
      purpose: 'nip46_signer',
      beforePage: startNip46Backend,
      exercise: async (targetPage, profile) => {
        const connection = `bunker://${profile.recoveryPubkey}?pubkey=${profile.recoveryPubkey}&relay=${encodeURIComponent(relayUrl)}`;
        await targetPage.getByRole('button', { name: 'Link device' }).click();
        await targetPage.getByLabel('Link device').fill(connection);
        await expect(targetPage.getByLabel('Relay')).toHaveCount(0);
        await targetPage.getByRole('button', { name: 'Continue' }).click();
      },
    });
  });
});
