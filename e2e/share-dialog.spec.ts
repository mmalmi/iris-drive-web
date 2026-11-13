import { expect, test } from './fixtures';
import { createDocument, createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createPresentation } from './slides.helpers';

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
});
