import { expect, test, type Page } from './fixtures';
import {
  clearAllStorage,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils.js';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, type Event } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import type { NostrIdentityKeyPurpose } from '../src/drive/protocolTypes';
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

  test('logs in with Recovery phrase recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, privateKeyFromSeedWords(SEED_WORDS), {
      purpose: 'recovery_phrase',
      exercise: async (targetPage) => {
        await targetPage.getByRole('button', { name: 'Recovery phrase' }).click();
        await targetPage.getByLabel('Recovery phrase').fill(SEED_WORDS);
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

  test('remote signer authorizes a new Drive device and discards its pairing credentials', async ({ page, relayUrl }) => {
    const transportKey = generateSecretKey();
    const link = `bunker://${getPublicKey(transportKey)}?relay=wss://signer.test&secret=single-use-test-secret`;
    const requests: string[] = [];
    await runRecoveryLogin(page, relayUrl, generateSecretKey(), {
      purpose: 'nip46_signer',
      beforePage: async (targetPage, profile) => {
        await targetPage.routeWebSocket(/^wss:\/\/signer\.test(?:\/|$)/, socket => {
          let subscription: string;
          socket.onMessage(raw => {
            const [type, value] = JSON.parse(raw.toString());
            if (type === 'REQ') { subscription = value; return; }
            if (type !== 'EVENT') return;
            socket.send(JSON.stringify(['OK', value.id, true, '']));
            const shared = nip44.v2.utils.getConversationKey(transportKey, value.pubkey);
            const { id, method, params } = JSON.parse(nip44.v2.decrypt(value.content, shared));
            requests.push(method);
            let result: string;
            switch (method) {
              case 'connect': result = 'ack'; break;
              case 'switch_relays': result = 'null'; break;
              case 'get_public_key': result = profile.recoveryPubkey; break;
              case 'sign_event': result = JSON.stringify(signWithRecoverySecret(profile, JSON.parse(params[0]))); break;
              case 'nip44_encrypt':
                result = nip44.v2.encrypt(params[1], nip44.v2.utils.getConversationKey(profile.recoverySecretKey, params[0])); break;
              case 'nip44_decrypt':
                result = nip44.v2.decrypt(params[1], nip44.v2.utils.getConversationKey(profile.recoverySecretKey, params[0])); break;
              default: throw new Error('Unexpected signer method');
            }
            const response = finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', value.pubkey]],
              content: nip44.v2.encrypt(JSON.stringify({ id, result }), shared) }, transportKey);
            socket.send(JSON.stringify(['EVENT', subscription, response]));
          });
        });
      },
      exercise: async (targetPage, profile) => {
        await targetPage.getByRole('button', { name: 'Sign in with remote signer' }).click();
        await targetPage.getByLabel('Signer connection link').fill(link);
        await targetPage.getByRole('button', { name: 'Connect', exact: true }).click();
        await assertRecovered(targetPage, profile);
        expect(requests.filter(method => method === 'connect')).toHaveLength(1);
        expect(requests).toContain('sign_event');
        expect(await targetPage.evaluate(() => Object.values(localStorage).some(value => value.includes('signer.test')))).toBe(false);
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
    await expect(page.getByTestId('identity-recovery-create-new-view')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('No existing Drive user found for that key')).toBeVisible();
    await expect(page.getByTestId('identity-create-name')).toBeVisible();
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeVisible();
    await expect(page.getByTestId('identity-create-name')).toHaveValue('');
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeEnabled();
  });
});
