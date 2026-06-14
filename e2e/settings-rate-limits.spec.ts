import { test, expect, type Page } from './fixtures';
import { disableOthersPool, setupPageErrorHandler, waitForAppReady } from './test-utils.js';

async function openP2PSettings(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await waitForAppReady(page);
  await disableOthersPool(page);
  await expect(page.getByRole('button', { name: 'Network' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Network' }).click();
  await page.getByTestId('settings-network-p2p').click();
}

test.describe('P2P Rate Limits', () => {
  test.setTimeout(90000);

  test('syncs upload and forwarding settings into the live worker adapter', async ({ page }) => {
    setupPageErrorHandler(page);
    await openP2PSettings(page);

    await expect(page.getByTestId('settings-upload-cap-toggle')).toBeChecked();
    await expect(page.getByTestId('settings-upload-cap-kbps')).toHaveValue('1024');
    await expect(page.getByTestId('settings-forward-limit-toggle')).toBeChecked();

    await page.getByTestId('settings-upload-cap-kbps').fill('256');
    await page.getByTestId('settings-upload-cap-kbps').blur();
    await page.getByTestId('settings-forward-limit-requests').fill('12');
    await page.getByTestId('settings-forward-limit-requests').blur();
    await page.getByTestId('settings-forward-limit-window').fill('1500');
    await page.getByTestId('settings-forward-limit-window').blur();

    await page.waitForFunction(() => {
      const win = window as any;
      const adapter = win.__getWorkerAdapter?.() ?? win.__workerAdapter;
      const uploadLimit = adapter?.webrtcProxy?.uploadRateLimiter?.getBytesPerSecond?.() ?? null;
      const configUploadLimit = adapter?.config?.maxWebRTCUploadBytesPerSecond ?? null;
      const forwardRateLimit = adapter?.config?.forwardRateLimit ?? null;

      return uploadLimit === 256 * 1024
        && configUploadLimit === 256 * 1024
        && forwardRateLimit?.maxForwardsPerPeerWindow === 12
        && forwardRateLimit?.windowMs === 1500;
    }, { timeout: 10000 });

    await page.reload();
    await waitForAppReady(page);
    await page.getByRole('button', { name: 'Network' }).click();
    await page.getByTestId('settings-network-p2p').click();

    await expect(page.getByTestId('settings-upload-cap-kbps')).toHaveValue('256');
    await expect(page.getByTestId('settings-upload-cap-use-default')).toBeVisible();
    await expect(page.getByTestId('settings-forward-limit-requests')).toHaveValue('12');
    await expect(page.getByTestId('settings-forward-limit-window')).toHaveValue('1500');

    await page.getByTestId('settings-upload-cap-toggle').uncheck();
    await page.waitForFunction(() => {
      const win = window as any;
      const adapter = win.__getWorkerAdapter?.() ?? win.__workerAdapter;
      const uploadLimit = adapter?.webrtcProxy?.uploadRateLimiter?.getBytesPerSecond?.() ?? null;
      const configUploadLimit = adapter?.config?.maxWebRTCUploadBytesPerSecond ?? null;
      return uploadLimit === null && configUploadLimit === null;
    }, { timeout: 10000 });
  });
});
