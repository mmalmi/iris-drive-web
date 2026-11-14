import { expect, test, type Page } from './fixtures';
import { setupPageErrorHandler, waitForAppReady } from './test-utils.js';

async function goToSettings(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await waitForAppReady(page);
  await expect(page.getByRole('button', { name: 'Storage' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings Stats', () => {
  test('displays local storage statistics', async ({ page }) => {
    setupPageErrorHandler(page);
    await goToSettings(page);
    await page.getByRole('button', { name: 'Storage' }).click();

    await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Used', { exact: true })).toBeVisible();
    await expect(page.getByTestId('storage-size')).toBeVisible();
  });

  test('describes direct connections as devices, not as people', async ({ page }) => {
    setupPageErrorHandler(page);
    await goToSettings(page);
    await page.getByTestId('settings-advanced-toggle').click();
    await page.getByRole('button', { name: 'Network' }).click();
    await page.getByTestId('settings-network-p2p').click();

    const section = page.getByTestId('settings-fips-peers');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('Devices running Iris that this one exchanges data with directly');
    await expect(section).toContainText('connected over WebRTC (FIPS)');
    await expect(section).not.toContainText('Connection Pools');
    await expect(section).not.toContainText('Follows');
  });
});
