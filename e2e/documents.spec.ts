import { expect, test } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

test.describe('documents in a Drive', () => {
  test.setTimeout(180_000);

  test('a new document keeps what was written after a reload', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page);
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });

    await createDocument(page, 'Trip plan');
    await expect(page).toHaveURL(/Trip%20plan\.irisdoc$/);
    await typeInDocument(page, 'Pack the tent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Buy maps');
    await expectSaved(page);
    await page.screenshot({ path: testInfo.outputPath('document-editing.png') });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Pack the tent', { timeout: 60_000 });
    await expect(documentBody(page)).toContainText('Buy maps');

    // The document shows as one item in its folder, under its title.
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByRole('link', { name: /^Trip plan\b/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('document-in-folder.png') });
  });
});
