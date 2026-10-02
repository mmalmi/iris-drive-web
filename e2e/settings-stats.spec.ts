import { expect, test, type Page } from './fixtures';
import { setupPageErrorHandler, waitForAppReady } from './test-utils.js';

async function goToSettings(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await waitForAppReady(page);
  await expect(page.getByRole('button', { name: 'Network' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings Stats', () => {
  test('displays local storage statistics', async ({ page }) => {
    setupPageErrorHandler(page);
    await goToSettings(page);
    await page.getByRole('button', { name: 'Storage' }).click();

    await expect(page.getByText('Local Storage').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Items', { exact: true })).toBeVisible();
    await expect(page.getByText('Size', { exact: true })).toBeVisible();
  });

  test('describes FIPS device peers without treating them as Nostr users', async ({ page }) => {
    setupPageErrorHandler(page);
    await goToSettings(page);
    await page.getByRole('button', { name: 'Network' }).click();
    await page.getByTestId('settings-network-p2p').click();

    const section = page.getByTestId('settings-fips-peers');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('Device peers discovered over Nostr and connected through authenticated FIPS WebRTC.');
    await expect(section).not.toContainText('Connection Pools');
    await expect(section).not.toContainText('Follows');
  });
});
