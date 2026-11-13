import { expect, test } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellBox,
  cellCenter,
  clickCell,
  createSpreadsheet,
  dragCells,
  expectCell,
  expectSaved,
  goTo,
  typeTable,
  waitForGrid,
} from './sheets.helpers';

test.describe('spreadsheets in a Drive', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a budget with formulas is still there after a reload', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Budget');
    await expect(page).toHaveURL(/Budget\.irissheet$/);
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');

    await typeTable(page, 'A1', [
      ['Item', 'Monthly', 'Months', 'Year'],
      ['Rent', '$950', '12', '=B2*C2'],
      ['Food', '$320.50', '12', '=B3*C3'],
      ['Travel', '$1,200', '1', '=B4*C4'],
      ['Total', '', '', '=SUM(D2:D4)'],
    ]);
    // Enter after tabbing along a row returns under where the row began.
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A6');
    await expectCell(page, 'D2', '$11,400.00');
    await expectCell(page, 'D3', '$3,846.00');
    await expectCell(page, 'D5', '$16,446.00');
    await expectCell(page, 'B4', '$1,200.00');

    // Changing a number updates everything that depends on it.
    await goTo(page, 'B2');
    await page.keyboard.type('1000');
    await page.keyboard.press('Enter');
    await expectCell(page, 'B2', '$1,000.00');
    await expectCell(page, 'D5', '$17,046.00');

    // The formula bar shows the formula, the cell its result.
    await goTo(page, 'D5');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=SUM(D2:D4)');

    // Bold header row, by selecting the row and using the toolbar.
    const header = await cellBox(page, 'A1');
    await page.mouse.click(header.left + header.headerWidth / 2, header.y + header.height / 2);
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1:Z1');
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');

    await expectSaved(page);
    await page.screenshot({ path: testInfo.outputPath('budget.png') });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expectCell(page, 'A5', 'Total');
    await expectCell(page, 'D5', '$17,046.00');
    await goTo(page, 'D3');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=B3*C3');
    await goTo(page, 'B1');
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');

    // It shows as one item in its folder, under its title.
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByRole('link', { name: /^Budget\b/ }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('typing, navigating, undo and the clipboard behave as in other spreadsheets', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Keys');

    // Typing replaces, Escape cancels, F2 and double-click open the content for changing.
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A2');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.type('gone');
    await page.keyboard.press('Escape');
    await expectCell(page, 'A1', 'first');
    await page.keyboard.press('F2');
    await page.keyboard.type(' cell');
    await page.keyboard.press('Enter');
    await expectCell(page, 'A1', 'first cell');
    const a1 = await cellCenter(page, 'A1');
    await page.mouse.dblclick(a1.x, a1.y);
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue('first cell');
    await page.keyboard.press('Home');
    await page.keyboard.type('The ');
    await page.keyboard.press('Tab');
    await expectCell(page, 'A1', 'The first cell');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'B1');

    // Arrow keys finish an entry that was started by typing.
    await page.keyboard.type('12');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('30');
    await page.keyboard.press('ArrowDown');
    await expectCell(page, 'B1', '12');
    await expectCell(page, 'C1', '30');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C2');

    // Undo and redo, one entry at a time, and the selection goes back with them.
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'C1', '');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C1');
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'B1', '');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await page.keyboard.press('ControlOrMeta+y');
    await expectCell(page, 'B1', '12');
    await expectCell(page, 'C1', '30');

    // Ctrl+arrows jump to the edge of the filled cells; Shift extends the selection.
    await typeTable(page, 'A3', [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']]);
    await goTo(page, 'A3');
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A5');
    await page.keyboard.press('ControlOrMeta+ArrowRight');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C5');
    await page.keyboard.press('ControlOrMeta+Home');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
    await goTo(page, 'A3');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A3:B5');
    await expect(page.getByTestId('sheet-status')).toContainText('Sum 27');

    // Copy the block and paste it elsewhere; then cut and paste moves it.
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1\t2\n4\t5\n7\t8');
    await goTo(page, 'E3');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCell(page, 'F5', '8');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'E3:F5');
    await page.keyboard.press('ControlOrMeta+x');
    await goTo(page, 'E8');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCell(page, 'E3', '');
    await expectCell(page, 'F10', '8');

    // Text copied from another program lands as rows and columns, numbers as numbers.
    await page.evaluate(() => navigator.clipboard.writeText('Name\tScore\r\nAda\t91.5\r\n"Grace, B."\t88\r\n'));
    await goTo(page, 'H1');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCell(page, 'H3', 'Grace, B.');
    await goTo(page, 'I4');
    await page.keyboard.type('=AVERAGE(I2:I3)');
    await page.keyboard.press('Enter');
    await expectCell(page, 'I4', '89.75');

    // Delete clears a selection.
    await goTo(page, 'A3');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
    await page.keyboard.press('Delete');
    await expectCell(page, 'A3', '');
    await expectCell(page, 'C3', '');
    await expectCell(page, 'A4', '4');
    await page.screenshot({ path: testInfo.outputPath('keys.png') });
  });

  test('formulas take cell addresses from clicks and follow inserted and deleted rows', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Formulas');
    await typeTable(page, 'A1', [['10', '1'], ['20', '2'], ['30', '3']]);

    // Type "=SUM(" then drag over the cells to add up.
    await goTo(page, 'D1');
    await page.keyboard.type('=SUM(');
    await dragCells(page, 'A1', 'A3');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue('=SUM(A1:A3');
    await page.keyboard.type(')*');
    await clickCell(page, 'B2');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue('=SUM(A1:A3)*B2');
    await page.screenshot({ path: testInfo.outputPath('pointing.png') });
    await page.keyboard.press('Enter');
    await expectCell(page, 'D1', '120');

    // The same from the formula bar, with arrow keys instead of the mouse.
    await goTo(page, 'D2');
    await page.keyboard.type('=');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue('=B2');
    await page.keyboard.type('+');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue('=B2+D1');
    await page.keyboard.press('Enter');
    await expectCell(page, 'D2', '122');

    // A new row in the middle of the summed range is summed too.
    await clickCell(page, 'A2', { button: 'right' });
    await page.getByTestId('menu-insert-row-above').click();
    await goTo(page, 'A2');
    await page.keyboard.type('5');
    await page.keyboard.press('Enter');
    await expectCell(page, 'D1', '130');
    await goTo(page, 'D1');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=SUM(A1:A4)*B3');

    // Deleting a row the formula read by address leaves an error that says why.
    await clickCell(page, 'A3', { button: 'right' });
    await page.getByTestId('menu-delete-row').click();
    await expectCell(page, 'D1', '#REF!');
    await goTo(page, 'D1');
    await expect(page.getByTestId('sheet-status')).toContainText('deleted');
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'D1', '130');

    // A formula that reads itself is caught.
    await goTo(page, 'F1');
    await page.keyboard.type('=F1+1');
    await page.keyboard.press('Enter');
    await expectCell(page, 'F1', '#CYCLE!');
    await page.screenshot({ path: testInfo.outputPath('formulas.png') });
  });
});
