import { expect, test } from './fixtures';
import { setupPageErrorHandler, waitForAppReady } from './test-utils.js';

test('bandwidth indicator samples from a stable baseline before showing rates', async ({ page }) => {
  setupPageErrorHandler(page);
  await page.goto('/');
  await waitForAppReady(page);

  await page.evaluate(() => {
    window.__setPoolSettings?.({ showBandwidth: true });
  });

  const indicator = page.getByTestId('bandwidth-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute('title', /Upload:\s*0 B\/s, Download:\s*0 B\/s/);

  await page.evaluate(() => {
    const store = (window as Window & {
      __appStore?: {
        setBlossomBandwidth?: (stats: {
          totalBytesSent: number;
          totalBytesReceived: number;
          updatedAt: number;
          servers: Array<{ url: string; bytesSent: number; bytesReceived: number }>;
        }) => void;
      };
    }).__appStore;

    const stats = {
      totalBytesSent: 2 * 1024 * 1024,
      totalBytesReceived: 1 * 1024 * 1024,
      updatedAt: Date.now(),
      servers: [
        {
          url: 'https://upload.iris.to',
          bytesSent: 2 * 1024 * 1024,
          bytesReceived: 1 * 1024 * 1024,
        },
      ],
    };

    const apply = () => store?.setBlossomBandwidth?.({
      ...stats,
      updatedAt: Date.now(),
    });

    apply();
    const timer = window.setInterval(apply, 100);
    window.setTimeout(() => window.clearInterval(timer), 1500);
  });

  await page.waitForTimeout(50);
  await expect(indicator).toHaveAttribute('title', /Upload:\s*0 B\/s, Download:\s*0 B\/s/);
  await expect.poll(async () => (
    (await indicator.getAttribute('title')) ?? ''
  )).toMatch(/Upload:\s*(?!0 B\/s).+\/s, Download:\s*(?!0 B\/s).+\/s/);
});
