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
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, type Event } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import WebSocket from 'ws';
import {
  signIrisProfileFacetAcceptance,
  signIrisProfileRosterOp,
  type IrisProfileKeyPurpose,
} from '../src/drive/protocol';

const SEED_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type RecoveryProfile = {
  profileId: string;
  recoverySecretKey: Uint8Array;
  recoveryPubkey: string;
  recoveryNsec: string;
};

type RecoveryRunOptions = {
  purpose: IrisProfileKeyPurpose;
  beforePage?: (page: Page, profile: RecoveryProfile, relayUrl: string) => Promise<(() => void) | void>;
  exercise: (page: Page, profile: RecoveryProfile, relayUrl: string) => Promise<void>;
};

async function publishEvent(relayUrl: string, event: Event): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out publishing event ${event.id}`));
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify(['EVENT', event]));
    });

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id && msg[2] === true) {
          clearTimeout(timeout);
          socket.close();
          resolve();
        }
      } catch {
        // Ignore non-JSON relay chatter.
      }
    });

    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function seedRecoverableProfile(
  relayUrl: string,
  recoverySecretKey: Uint8Array,
  purpose: IrisProfileKeyPurpose,
): Promise<RecoveryProfile> {
  const profileId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const adminSecretKey = generateSecretKey();
  const adminPubkey = getPublicKey(adminSecretKey);
  const recoveryPubkey = getPublicKey(recoverySecretKey);
  const recoveryNsec = nip19.nsecEncode(recoverySecretKey);

  const bootstrap = signIrisProfileRosterOp({
    signerSecretKey: adminSecretKey,
    profileId,
    createdAt: now,
    clientNonce: `bootstrap-${profileId}`,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: adminPubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_key_wraps: true,
          can_decrypt_key_epochs: true,
        },
        added_at: now,
        label: 'Admin',
      },
    },
  });
  const addRecovery = signIrisProfileRosterOp({
    signerSecretKey: adminSecretKey,
    profileId,
    parents: [bootstrap.op_id],
    createdAt: now + 1,
    clientNonce: `add-recovery-${profileId}`,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: recoveryPubkey,
        purposes: [purpose],
        capabilities: {
          can_recover_app_keys: true,
          can_receive_key_wraps: true,
          can_decrypt_key_epochs: true,
        },
        added_at: now + 1,
        label: 'Recovery key',
      },
    },
  });
  const recoveryAcceptance = signIrisProfileFacetAcceptance({
    signerSecretKey: recoverySecretKey,
    profileId,
    purposes: [purpose],
    rosterOpId: addRecovery.op_id,
    acceptedAt: now + 2,
    clientNonce: `accept-recovery-${profileId}`,
  });

  await publishEvent(relayUrl, JSON.parse(bootstrap.event_json));
  await publishEvent(relayUrl, JSON.parse(addRecovery.event_json));
  await publishEvent(relayUrl, JSON.parse(recoveryAcceptance.event_json));

  return {
    profileId,
    recoverySecretKey,
    recoveryPubkey,
    recoveryNsec,
  };
}

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
  await expect(page).toHaveURL(/#\/npub1[a-z0-9]+\/main/, { timeout: 30000 });
  await page.waitForFunction((profileId) => {
    const accounts = JSON.parse(localStorage.getItem('hashtree:accounts') ?? '[]');
    const activePubkey = localStorage.getItem('hashtree:activeAccount');
    const session = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return session?.profileId === profileId
      && accounts.some((account: {
        pubkey?: string;
        type?: string;
        irisProfileId?: string;
        nsec?: string;
      }) => account.pubkey === activePubkey
        && account.type === 'drive_profile'
        && account.irisProfileId === profileId
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
  await page.exposeFunction('__irisTestNip07SignEvent', (draft: Event) => (
    finalizeEvent({
      kind: draft.kind,
      content: draft.content,
      created_at: draft.created_at,
      tags: draft.tags.map((tag) => tag.slice()),
    }, profile.recoverySecretKey)
  ));
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
        await targetPage.getByRole('button', { name: 'Recover app key' }).click();
      },
    });
  });

  test('logs in with Seed phrase recovery', async ({ page, relayUrl }) => {
    await runRecoveryLogin(page, relayUrl, privateKeyFromSeedWords(SEED_WORDS), {
      purpose: 'recovery_phrase',
      exercise: async (targetPage) => {
        await targetPage.getByRole('button', { name: 'Seed phrase' }).click();
        await targetPage.getByLabel('Seed phrase').fill(SEED_WORDS);
        await targetPage.getByRole('button', { name: 'Recover app key' }).click();
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
        await expect(targetPage.getByRole('button', { name: 'Recover app key' })).toHaveCount(0);
      },
    });
  });

  test('offers Create new when Browser extension has no Drive identity', async ({ page, relayUrl }) => {
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
    await expect(page.getByRole('button', { name: 'Recover app key' })).toHaveCount(0);
    await expect(page.getByTestId('identity-recovery-create-new-view')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('No existing Drive user found for that key')).toBeVisible();
    await expect(page.getByTestId('create-new-after-recovery-miss')).toBeVisible();
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
        await targetPage.getByLabel('Relay').fill(relayUrl);
        await targetPage.getByRole('button', { name: 'Recover app key' }).click();
      },
    });
  });
});
