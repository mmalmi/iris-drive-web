import { expect, test, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';
import { createSpreadsheet, expectCell, typeTable, waitForGrid } from './sheets.helpers';
import { createPresentation, thumbs } from './slides.helpers';

/** Renames the open document, spreadsheet or presentation the way a person does: click the title, type, Enter. */
async function renameTo(page: Page, from: string, to: string): Promise<void> {
  await page.getByTestId('document-title').click();
  const field = page.getByTestId('document-title-input');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(from);
  await field.fill(to);
  await field.press('Enter');
}

test.describe('renaming from the title', () => {
  test.setTimeout(240_000);

  test('a document, a spreadsheet and a presentation take a new name and keep their content', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);

    await createDocument(page, 'Draft');
    await typeInDocument(page, 'Kept words');
    await expectSaved(page);
    await renameTo(page, 'Draft', 'Final report');
    await expect(page.getByTestId('document-title')).toHaveText('Final report');
    await expect(page).toHaveURL(/Final%20report\.irisdoc/);
    await expect(documentBody(page)).toContainText('Kept words', { timeout: 30_000 });
    // It goes on saving under the new name.
    await typeInDocument(page, ' and more');
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Kept words and more', { timeout: 60_000 });
    // Escape leaves the name as it was.
    await page.getByTestId('document-title').click();
    await page.getByTestId('document-title-input').fill('Not this');
    await page.getByTestId('document-title-input').press('Escape');
    await expect(page.getByTestId('document-title')).toHaveText('Final report');

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByTestId('file-list').getByText('Final report', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('file-list').getByText('Draft', { exact: true })).toHaveCount(0);

    await createSpreadsheet(page, 'Numbers');
    await typeTable(page, 'A1', [['Pens', '4']]);
    await expectSaved(page);
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createSpreadsheet(page, 'Totals');
    // A name something else in the folder has is refused, and the title stays.
    await renameTo(page, 'Totals', 'Numbers');
    await expect(page.getByText('There is already something named "Numbers" here.')).toBeVisible();
    await expect(page.getByTestId('document-title')).toHaveText('Totals');
    await expect(page).toHaveURL(/Totals\.irissheet/);
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await page.getByTestId('file-list').getByText('Numbers', { exact: true }).dblclick();
    await waitForGrid(page);
    await renameTo(page, 'Numbers', 'Stock');
    await expect(page.getByTestId('document-title')).toHaveText('Stock');
    await waitForGrid(page);
    await expectCell(page, 'B1', '4');

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createPresentation(page, 'Deck');
    await renameTo(page, 'Deck', 'Pitch deck');
    await expect(page.getByTestId('document-title')).toHaveText('Pitch deck');
    await expect(thumbs(page)).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('link', { name: 'Back to folder' }).click();
    const list = page.getByTestId('file-list');
    await expect(list.getByText('Pitch deck', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(list.getByText('Stock', { exact: true })).toBeVisible();
    await expect(list.getByText('Totals', { exact: true })).toBeVisible();
    await expect(list.getByText('Final report', { exact: true })).toBeVisible();
  });
});
