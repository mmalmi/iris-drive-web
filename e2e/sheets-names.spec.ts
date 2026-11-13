import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createSpreadsheet, dragCells, expectCell, goTo, shotPath, typeTable } from './sheets.helpers';

test.describe('frozen rows and named ranges', () => {
  test.setTimeout(240_000);

  test('freezing up to the selection, and naming cells to use in formulas', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Budget');
    await typeTable(page, 'A1', [
      ['Budget 2026', '', ''],
      ['', '', ''],
      ['Item', 'Cost', 'Paid'],
      ['Rent', '900', '900'],
      ['Food', '350', '200'],
      ['Travel', '120', '0'],
    ]);

    // Name the costs from the box left of the formula bar.
    await dragCells(page, 'B4', 'B6');
    const box = page.getByTestId('sheet-name-box');
    await box.click();
    await box.fill('Costs');
    await box.press('Enter');
    await expect(page.getByTestId('sheet-status')).toContainText('Costs now stands for B4:B6');
    await goTo(page, 'E1');
    await page.keyboard.type('=SUM(Costs)');
    await page.keyboard.press('Enter');
    await expectCell(page, 'E1', '1370');
    await goTo(page, 'B5');
    await page.keyboard.type('400');
    await page.keyboard.press('Enter');
    await expectCell(page, 'E1', '1420');

    // The name jumps back to its cells.
    await box.click();
    await box.fill('costs');
    await box.press('Enter');
    await expect(page.getByTestId('sheet-active-cell')).toHaveAttribute('data-cell', 'B4:B6');

    // Listed, and made from the panel too.
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('sheet-names').click();
    await expect(page.getByTestId('named-range')).toContainText('Sheet1!B4:B6');
    await page.getByTestId('names-name').fill('Paid');
    await page.getByTestId('names-range').fill('C4:C6');
    await page.getByTestId('names-add').click();
    await expect(page.getByTestId('named-range')).toHaveCount(2);
    await page.getByTestId('side-panel-close').click();
    await goTo(page, 'E2');
    await page.keyboard.type('=SUM(Costs)-SUM(Paid)');
    await page.keyboard.press('Enter');
    await expectCell(page, 'E2', '320');

    // Freeze the title and the header row: up to row 3.
    await goTo(page, 'B3');
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('menu-freeze-rows').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sheet: { ctl: { sheet: { freezeRows: number } } } }).__sheet.ctl.sheet.freezeRows)).toBe(3);
    await page.locator('[data-testid="sheet-grid"] [data-scrollable]').evaluate((element) => element.scrollBy(0, 400));
    await page.screenshot({ path: shotPath(testInfo, 'names-frozen.png') });
    await expectCell(page, 'A3', 'Item');
    await page.getByTestId('sheet-more').click();
    await expect(page.getByTestId('menu-freeze-rows')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('menu-unfreeze').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sheet: { ctl: { sheet: { freezeRows: number } } } }).__sheet.ctl.sheet.freezeRows)).toBe(0);
  });
});
