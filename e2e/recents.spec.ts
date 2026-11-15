import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createTextFile } from './test-utils';

test.describe('Recent', () => {
  test.setTimeout(120_000);

  test('lists what was opened, newest first, keeps it after a reload, opens it again and clears', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Recent Test');
    await createAndEnterFolder(page, 'Trip');
    // Going back from the new file to its folder must not list the folder as a file.
    await createTextFile(page, 'plan.txt', 'Pack the tent');
    await page.getByTestId('file-list').getByRole('link', { name: /^plan\.txt/ }).dblclick();
    await expect(page.locator('pre')).toContainText('Pack the tent', { timeout: 30_000 });

    const recent = page.getByTestId('drive-sidebar').getByRole('link', { name: 'Recent' });
    const rows = page.getByTestId('recents-view').getByRole('link');
    await recent.click();
    await expect(rows.first()).toContainText('plan.txt');
    await expect(rows.filter({ hasText: 'My Drive' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Trip' })).toHaveCount(0);

    await page.reload();
    await expect(rows.first()).toContainText('plan.txt', { timeout: 30_000 });
    await rows.first().click();
    await expect(page).toHaveURL(/\/main\/Trip\/plan\.txt$/);
    await expect(page.locator('pre')).toContainText('Pack the tent', { timeout: 30_000 });

    await recent.click();
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByText('Files and folders you open show up here.')).toBeVisible();
  });
});
