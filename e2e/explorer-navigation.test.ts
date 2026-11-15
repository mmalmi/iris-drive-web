import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createTextFile } from './test-utils';

test.describe('addresses opened directly', () => {
  test.setTimeout(120_000);

  test('a file\'s address shows the file, on a wide window and on a phone', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Address Test');
    await createAndEnterFolder(page, 'Direct');
    await createTextFile(page, 'readme.txt', 'Hello Direct Nav');
    await page.getByTestId('file-list').getByRole('link', { name: /^readme\.txt/ }).dblclick();
    await expect(page.locator('pre')).toContainText('Hello Direct Nav', { timeout: 30_000 });
    const fileUrl = page.url();

    for (const size of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) {
      await page.getByTestId('home-link').click();
      await page.setViewportSize(size);
      await page.goto(fileUrl);
      await page.reload();
      await expect(page.getByTestId('viewer-header')).toContainText('readme.txt', { timeout: 30_000 });
      await expect(page.locator('pre')).toContainText('Hello Direct Nav', { timeout: 30_000 });
    }
  });

  test('the old profile, follows and edit addresses open the person page', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { npub } = await createDriveProfile(page, 'Person Test');
    for (const suffix of ['profile', 'follows', 'followers', 'edit', '']) {
      await page.goto(`/#/${npub}${suffix ? `/${suffix}` : ''}`);
      await expect(page.getByTestId('person-page')).toBeVisible({ timeout: 30_000 });
    }
  });
});
