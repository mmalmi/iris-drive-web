import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createTextFile } from './test-utils';

test('a small file opens without a loading message flashing up first', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Loading Test');
  await createTextFile(page, 'quick.txt', 'Quick content');

  // Note every time the loading message is put on the page.
  await page.evaluate(() => {
    const seen = { count: 0 };
    (window as unknown as { __loadingSeen: typeof seen }).__loadingSeen = seen;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="loading-indicator"]')) seen.count += 1;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.getByTestId('file-list').getByRole('link', { name: /^quick\.txt/ }).click();
  await expect(page.locator('pre')).toContainText('Quick content', { timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __loadingSeen: { count: number } }).__loadingSeen.count)).toBe(0);
});
