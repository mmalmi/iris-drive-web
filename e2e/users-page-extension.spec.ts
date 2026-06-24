import { test, expect } from './fixtures';
import { safeReload, waitForAppReady } from './test-utils';

test.describe('Users Page NIP-07 availability', () => {
  test('enables recovery extension option after reload when NIP-07 appears shortly after load', async ({ page }) => {
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
    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    const extensionOption = page.getByRole('button', { name: 'Browser extension' });
    await expect(extensionOption).toBeEnabled({ timeout: 5000 });
    const extensionBox = await extensionOption.boundingBox();
    const seedBox = await page.getByRole('button', { name: 'Seed phrase' }).boundingBox();
    expect(extensionBox).not.toBeNull();
    expect(seedBox).not.toBeNull();
    expect(extensionBox!.y).toBeLessThan(seedBox!.y);

    await safeReload(page);
    await waitForAppReady(page);
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByRole('button', { name: 'Browser extension' })).toBeEnabled({ timeout: 5000 });
  });
});
