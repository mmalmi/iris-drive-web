// A column's right click sorts the sheet by it, and a cell's or a column's
// turns the filter on and off, as in Google Sheets.
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { clickCell, clickHeader, createSpreadsheet, expectCell, typeTable, waitForGrid } from './sheets.helpers';

test.describe('a right click in a spreadsheet', () => {
  test.setTimeout(180_000);

  test('sorts by a column and turns the filter on and off', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Sorter');
    await createSpreadsheet(page, 'Scores');
    await waitForGrid(page);
    await typeTable(page, 'A1', [['Name', 'Score'], ['Cara', '30'], ['Ana', '10'], ['Bo', '20']]);

    await clickHeader(page, 'B', { button: 'right' });
    await page.getByTestId('menu-sort-az').click();
    // The heading stays on top; each name goes with its score.
    await expectCell(page, 'B1', 'Score');
    await expectCell(page, 'B2', '10');
    await expectCell(page, 'A2', 'Ana');
    await expectCell(page, 'A4', 'Cara');
    await clickHeader(page, 'B', { button: 'right' });
    await page.getByTestId('menu-sort-za').click();
    await expectCell(page, 'A2', 'Cara');

    await clickCell(page, 'A2', { button: 'right' });
    await expect(page.getByTestId('menu-filter')).toHaveText('Create a filter');
    await page.getByTestId('menu-filter').click();
    await clickCell(page, 'A3', { button: 'right' });
    await expect(page.getByTestId('menu-filter')).toHaveText('Remove filter');
    await page.getByTestId('menu-filter').click();
    await clickHeader(page, 'A', { button: 'right' });
    await expect(page.getByTestId('menu-filter')).toHaveText('Create a filter');
  });
});
