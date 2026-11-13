import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellBox,
  cellStyle,
  clickCell,
  createSpreadsheet,
  dragCells,
  expectCell,
  expectSaved,
  goTo,
  shotPath,
  typeTable,
  waitForGrid,
} from './sheets.helpers';

test.describe('a spreadsheet that looks the part', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a budget gets a merged title, borders and a larger font, and cut cells keep their formulas', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Household');
    await typeTable(page, 'A1', [
      ['Household budget'],
      ['Item', 'Planned', 'Spent', 'Left'],
      ['Rent', '900', '900', '=B3-C3'],
      ['Food', '400', '352.5', '=B4-C4'],
      ['Travel', '150', '170', '=B5-C5'],
      ['Total', '=SUM(B3:B5)', '=SUM(C3:C5)', '=SUM(D3:D5)'],
    ]);

    // The title spans the table, larger and centred in the middle of a taller row.
    await dragCells(page, 'A1', 'D1');
    await page.getByTestId('sheet-merge').click();
    await page.getByTestId('merge-all').click();
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
    await page.getByTestId('sheet-font-size').selectOption('18');
    await page.getByTestId('sheet-align').click();
    await page.getByTestId('align-centre').click();
    await page.getByTestId('sheet-align').click();
    await page.getByTestId('align-middle').click();
    expect(await cellStyle(page, 'A1')).toMatchObject({ fs: 18, a: 'c', va: 'm' });
    expect((await cellBox(page, 'A1')).height).toBeGreaterThan(30);
    // Clicking any part of it selects the whole block; arrows step over it.
    await clickCell(page, 'C1');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
    await page.keyboard.press('ArrowDown');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A2');

    // Lines inside the table, a thick one around it, and a double-weight line over the total.
    await dragCells(page, 'A2', 'D6');
    await page.getByTestId('sheet-borders').click();
    await page.getByTestId('border-all').click();
    await page.getByTestId('sheet-borders').click();
    await page.getByTestId('border-kind-k').click();
    await page.getByTestId('border-outer').click();
    await dragCells(page, 'A6', 'D6');
    await page.getByTestId('sheet-borders').click();
    await page.getByTestId('border-kind-m').click();
    await page.getByTestId('border-color-#1c7ed6').click();
    await page.getByTestId('border-top').click();
    expect(await cellStyle(page, 'B6')).toMatchObject({ bt: 'm#1c7ed6', bb: 'k' });
    await dragCells(page, 'A2', 'D2');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.getByTestId('sheet-fill-color').click();
    await page.locator('[data-color="#d0bfff"]').click();
    await clickCell(page, 'F2');
    await page.screenshot({ path: shotPath(testInfo, 'looks-budget.png') });

    // Moving the spent column by cut and paste: the totals and differences follow it.
    await dragCells(page, 'C2', 'C6');
    await page.keyboard.press('ControlOrMeta+X');
    await clickCell(page, 'F2');
    await page.keyboard.press('ControlOrMeta+V');
    await expectCell(page, 'D4', '47.5');
    await goTo(page, 'D3');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=B3-F3');
    await page.keyboard.press('ControlOrMeta+Z');
    await expectCell(page, 'C4', '352.5');

    // A row added under Travel, from inside the summed rows, is summed.
    await clickCell(page, 'A5');
    await clickCell(page, 'A5', { button: 'right' });
    await page.getByTestId('menu-insert-row-below').click();
    await typeTable(page, 'A6', [['Gifts', '50', '20']]);
    await expectCell(page, 'B7', '1500');

    // Everything comes back after a reload, in light and dark.
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expectCell(page, 'A1', 'Household budget');
    expect(await cellStyle(page, 'B7')).toMatchObject({ bt: 'm#1c7ed6' });
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await clickCell(page, 'F3');
    await page.screenshot({ path: shotPath(testInfo, 'looks-budget-dark.png') });
  });
});
