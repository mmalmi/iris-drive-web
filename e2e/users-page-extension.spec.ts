import { test, expect } from './fixtures';
import { safeReload, waitForAppReady } from './test-utils';

test.describe('Users Page NIP-07 availability', () => {
  test('shows extension login after reload when NIP-07 appears shortly after load', async ({ page }) => {
    await page.addInitScript(() => {
      const installNostr = () => {
        if ((window as Window & { nostr?: unknown }).nostr) return;

        Object.defineProperty(window, 'nostr', {
          configurable: true,
          value: {
            getPublicKey: async () => 'f'.repeat(64),
            signEvent: async (event: Record<string, unknown>) => event,
            nip04: {
              encrypt: async () => '',
              decrypt: async () => '',
            },
            nip44: {
              encrypt: async () => '',
              decrypt: async () => '',
            },
          },
        });
      };

      setTimeout(installNostr, 2000);
    });

    await page.goto('/#/users');
    await waitForAppReady(page);
    await expect(page.getByTestId('generate-new-account')).toBeVisible();
    await expect(page.getByTestId('extension-login')).toBeVisible({ timeout: 5000 });

    await safeReload(page);
    await waitForAppReady(page);
    await expect(page.getByTestId('extension-login')).toBeVisible({ timeout: 5000 });
  });
});
