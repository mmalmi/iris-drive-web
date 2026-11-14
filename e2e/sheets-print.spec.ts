import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { clickHeader, createSpreadsheet, expectSaved, goTo, typeTable } from './sheets.helpers';

/**
 * Prints the way the toolbar's button does, without the browser's print
 * window, which cannot be driven here: what would go to paper is what the
 * page then shows for print.
 */
async function printFromToolbar(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.print = () => { window.dispatchEvent(new Event('beforeprint')); };
  });
  await page.getByRole('button', { name: 'Print', exact: true }).click();
  await page.emulateMedia({ media: 'print' });
}

async function endPrint(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({ media: 'screen' });
}

test.describe('printing a spreadsheet', () => {
  test.setTimeout(180_000);

  test('the cells in use print alone, as they look, with the frozen heading on every page', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Stock');
    const rows = [['Item', 'Count', 'Price']];
    for (let index = 1; index <= 60; index += 1) rows.push([`Item ${index}`, String(index), String(index * 1.5)]);
    await typeTable(page, 'A1', rows);
    // Prices as money, the heading bold and frozen, one row hidden.
    await goTo(page, 'C2');
    await page.keyboard.down('Shift');
    for (let index = 0; index < 60; index += 1) await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.getByTestId('sheet-number-format').selectOption('dollar');
    await goTo(page, 'A1');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await page.getByTestId('sheet-more').click();
    await page.getByRole('menuitemcheckbox', { name: 'Freeze first row' }).click();
    await clickHeader(page, '4', { button: 'right' });
    await page.getByTestId('menu-hide-row').click();
    await expectSaved(page);

    await printFromToolbar(page);
    const printed = page.getByTestId('sheet-print');
    await expect(printed).toBeVisible();
    // Nothing of the app is on paper: no toolbar, grid, tabs or sidebar.
    await expect(page.getByTestId('sheet-toolbar')).toBeHidden();
    await expect(page.getByTestId('sheet-grid')).toBeHidden();
    await expect(page.getByTestId('sheet-tabs')).toBeHidden();
    await expect(page.getByTestId('drive-sidebar')).toBeHidden();
    // The frozen row is the table's head, which the browser repeats on each page.
    await expect(printed.locator('thead tr')).toHaveCount(1);
    await expect(printed.locator('thead th')).toHaveText(['Item', 'Count', 'Price']);
    await expect(printed.locator('thead th').first()).toHaveCSS('font-weight', '700');
    // Only the cells in use, without the hidden row; values as the grid shows them.
    await expect(printed.locator('tbody tr')).toHaveCount(59);
    await expect(printed.locator('tbody tr').first().locator('td')).toHaveText(['Item 1', '1', '$1.50']);
    await expect(printed.locator('tbody tr').nth(2).locator('td').first()).toHaveText('Item 4');
    await expect(printed.locator('tbody tr').last().locator('td')).toHaveText(['Item 60', '60', '$90.00']);
    await expect(printed.locator('tbody tr').first().locator('td').nth(1)).toHaveCSS('text-align', 'right');
    // Rows are not cut in two by a page break, and the cells have lines.
    await expect(printed.locator('tbody tr').first()).toHaveCSS('break-inside', 'avoid');
    await expect(printed.locator('tbody td').first()).toHaveCSS('border-top-style', 'solid');
    await endPrint(page);
    await expect(page.getByTestId('sheet-print')).toHaveCount(0);
    await expect(page.getByTestId('sheet-grid')).toBeVisible();
  });

  test('a wide sheet turns the page, merged cells stay merged, and phones print from the browser menu only', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Year');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    await typeTable(page, 'A1', [['Sales by month'], months, months.map((_, index) => String(index * 10))]);
    await goTo(page, 'A1');
    await page.keyboard.down('Shift');
    for (let index = 0; index < 3; index += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await page.getByTestId('sheet-merge').click();
    await page.getByTestId('merge-all').click();
    await expectSaved(page);

    // Ctrl+P in the browser's own menu prints the same way.
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const printed = page.getByTestId('sheet-print');
    await expect(printed).toBeVisible();
    await expect(printed.locator('tr').first().locator('td, th').first()).toHaveAttribute('colspan', '4');
    await expect(printed.locator('tr').nth(1).locator('td')).toHaveCount(12);
    await expect(printed).toHaveAttribute('data-orientation', 'landscape');
    await endPrint(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('sheet-toolbar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeHidden();
  });
});
