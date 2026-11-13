import { test, expect, type Page } from './fixtures';
import { getPublicKey, nip19 } from 'nostr-tools';
import { disableOthersPool, setupPageErrorHandler, waitForAppReady, ensureLoggedIn } from './test-utils.js';
import { FOLLOW_SECKEY } from './nostr-test-keys';

const FOLLOW_PUBKEY = getPublicKey(FOLLOW_SECKEY);

async function currentWorkerRootDistance(page: Page) {
  return page.evaluate(async () => {
    const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
    const { nostrStore } = await import('/src/nostr/index.ts');
    const pubkey = nostrStore.getState().pubkey;
    const adapter = getWorkerAdapter();
    return {
      pubkey,
      distance: pubkey && adapter ? await adapter.getFollowDistance(pubkey) : null,
    };
  });
}

/**
 * Test that social graph root is set correctly on login and account switch
 */
test.describe('Social graph root', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
  });

  test('should set root when app loads with logged in user', async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await disableOthersPool(page);
    await ensureLoggedIn(page);

    // Read the real worker graph; the legacy getSocialGraph shim is only a local cache.
    const initialPubkey = (await currentWorkerRootDistance(page)).pubkey;
    expect(initialPubkey).toMatch(/^[a-f0-9]{64}$/);
    await expect.poll(() => currentWorkerRootDistance(page), { timeout: 10000 })
      .toEqual({ pubkey: initialPubkey, distance: 0 });

    // Exercise the production account-switch path without setting the graph root in the test.
    expect(FOLLOW_PUBKEY).not.toBe(initialPubkey);
    expect(await page.evaluate(async (nsec) => {
      const { loginWithNsec } = await import('/src/nostr.ts');
      return loginWithNsec(nsec);
    }, nip19.nsecEncode(FOLLOW_SECKEY))).toBe(true);
    await expect.poll(() => currentWorkerRootDistance(page), { timeout: 10000 })
      .toEqual({ pubkey: FOLLOW_PUBKEY, distance: 0 });
  });
});
