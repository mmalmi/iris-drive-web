import { expect, test } from './fixtures';
import { createDocument, createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createPresentation } from './slides.helpers';
import { createFolder } from './test-utils';

test.describe('the share dialog', () => {
  test.setTimeout(120_000);

  test('closes with Escape inside a presentation, and when going somewhere else', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Talk');
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toHaveCount(0);

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Notes');
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    // Going back to the folder, as with the browser's Back button.
    await page.goBack();
    await expect(page.getByTestId('share-modal')).toHaveCount(0);
  });

  test('keeps a folder you share in My Drive, not in Shared with me', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page);
    await createFolder(page, 'Projects');
    await page.getByRole('link', { name: /^Projects\b/ }).first().click();
    await createFolder(page, 'Trip');
    await page.getByRole('link', { name: /^Trip\b/ }).first().click();
    await expect(page).toHaveURL(/\/main\/Projects\/Trip$/, { timeout: 30_000 });

    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
    await page.getByTestId('share-people-create').click();
    await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    // Shared, the folder opens at its own address, still inside My Drive.
    await expect(page).not.toHaveURL(new RegExp(`#/${profileId}/`), { timeout: 30_000 });
    const path = page.getByRole('navigation', { name: 'Folder path' });
    await expect(path.getByRole('link', { name: 'My Drive' })).toHaveAttribute('href', `#/${profileId}/main`);
    await expect(path.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', `#/${profileId}/main/Projects`);
    await expect(path).not.toContainText('Shared with me');
    const sidebar = page.getByTestId('drive-sidebar');
    await expect(sidebar.getByRole('link', { name: 'My Drive' })).toHaveAttribute('aria-current', 'page');

    await sidebar.getByRole('link', { name: 'Shared with me' }).click();
    await expect(page.getByTestId('shared-with-me-panel')).toBeVisible();
    await expect(page.getByTestId('shared-with-me-row')).toHaveCount(0);
  });
});
