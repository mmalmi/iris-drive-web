import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { cellBox, cellStyle, clickCell, createSpreadsheet, dragCells, expectCell, expectSaved, goTo, shotPath, typeTable, waitForGrid } from './sheets.helpers';

/** How a cell is drawn: its look with the conditional formats applied. */
async function drawnLook(page: Page, name: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (cell) => {
    const { cellExtras } = await import('/src/lib/sheets/extras.ts');
    const { parseRectName } = await import('/src/lib/sheets/address.ts');
    const ctl = (window as unknown as { __sheet: { ctl: { sheet: never; engine: never } } }).__sheet.ctl;
    const at = parseRectName(cell) as { r1: number; c1: number };
    return { ...(cellExtras(ctl.sheet, ctl.engine)?.look(at.r1, at.c1) ?? {}) };
  }, name);
}

test.describe('checkboxes, lists and conditional colours', () => {
  test.setTimeout(240_000);

  test('a task list with checkboxes and a status list', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Tasks');
    await typeTable(page, 'A1', [
      ['Task', 'Done', 'Status'],
      ['Write plan', '', ''],
      ['Book venue', '', ''],
      ['Send invites', '', ''],
    ]);

    // Checkboxes in B2:B4.
    await dragCells(page, 'B2', 'B4');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-checkbox').click();
    await expect(page.getByTestId('validation-panel')).toBeVisible();
    await expectCell(page, 'B2', 'FALSE');
    await page.getByTestId('side-panel-close').click();
    const b3 = await cellBox(page, 'B3');
    await page.mouse.click(b3.x + b3.width / 2, b3.y + b3.height / 2);
    await expectCell(page, 'B3', 'TRUE');
    await goTo(page, 'B4');
    await page.keyboard.press('Space');
    await expectCell(page, 'B4', 'TRUE');
    await page.keyboard.press('Space');
    await expectCell(page, 'B4', 'FALSE');

    // A list of statuses in C2:C4.
    await dragCells(page, 'C2', 'C4');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-list').click();
    await page.getByTestId('validation-items').fill('Open\nDoing\nDone');
    await page.getByTestId('validation-items').blur();
    await page.getByTestId('validation-done').click();
    await expect(page.getByTestId('validation-rule').nth(1)).toHaveText('C2:C4 · List: Open, Doing, Done');
    await page.getByTestId('side-panel-close').click();
    const c2 = await cellBox(page, 'C2');
    await page.mouse.click(c2.x + c2.width - 8, c2.y + c2.height / 2);
    await page.getByTestId('list-choice-1').click();
    await expectCell(page, 'C2', 'Doing');
    await goTo(page, 'C3');
    await page.keyboard.press('Alt+ArrowDown');
    await page.getByTestId('list-choice-2').click();
    await expectCell(page, 'C3', 'Done');
    // Something not on the list is refused, with the reason beside the cell.
    await goTo(page, 'C4');
    await page.keyboard.type('Later');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sheet-edit-problem')).toHaveText('Choose one of: Open, Doing, Done.');
    await page.screenshot({ path: shotPath(testInfo, 'rules-refused.png') });
    await page.keyboard.press('Escape');
    await expectCell(page, 'C4', '');

    // Done tasks turn green.
    await dragCells(page, 'C2', 'C4');
    await page.getByTestId('sheet-conditional').click();
    await page.getByTestId('format-add').click();
    await page.getByTestId('format-condition').selectOption('eq');
    await page.getByTestId('format-value').fill('Done');
    await page.getByTestId('format-value').press('Enter');
    await page.getByTestId('format-fill-b7e1cd').click();
    await expect.poll(() => drawnLook(page, 'C3')).toMatchObject({ bg: '#b7e1cd' });
    expect((await drawnLook(page, 'C2')).bg).toBeUndefined();
    // The cell's own look is untouched.
    expect((await cellStyle(page, 'C3')).bg).toBeUndefined();
    await page.getByTestId('format-done').click();
    await clickCell(page, 'E8');
    await page.screenshot({ path: shotPath(testInfo, 'rules-task-list.png') });

    await page.getByTestId('side-panel-close').click();
    await goTo(page, 'E2');
    await page.keyboard.type('=COUNTIF(B2:B4, TRUE)');
    await page.keyboard.press('Enter');
    await expectCell(page, 'E2', '1');
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expectCell(page, 'B3', 'TRUE');
    await expect.poll(() => drawnLook(page, 'C3')).toMatchObject({ bg: '#b7e1cd' });
  });

  test('a sales table coloured by its numbers', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Regions');
    await typeTable(page, 'A1', [
      ['Region', 'Sales', 'Target'],
      ['North', '120', '100'],
      ['South', '80', '100'],
      ['East', '150', '100'],
      ['West', '95', '100'],
    ]);
    await dragCells(page, 'B2', 'B5');
    await page.getByTestId('sheet-conditional').click();
    await page.getByTestId('format-add').click();
    await page.getByTestId('format-scale').click();
    await page.getByTestId('format-scale-red-yellow-green').click();
    await page.getByTestId('format-done').click();
    await expect(page.getByTestId('format-rule')).toContainText('B2:B5 · Colour scale');
    await expect.poll(async () => (await drawnLook(page, 'B4')).bg).toBe('#57bb8a');
    expect((await drawnLook(page, 'B3')).bg).toBe('#e67c73');

    await dragCells(page, 'C2', 'C5');
    await page.getByTestId('format-add').click();
    await page.getByTestId('format-condition').selectOption('lt');
    await page.getByTestId('format-value').fill('101');
    await page.getByTestId('format-value').press('Enter');
    await page.getByTestId('format-fill-f4c7c3').click();
    await page.getByTestId('format-done').click();
    await expect(page.getByTestId('format-rule')).toHaveCount(2);
    await expect.poll(async () => (await drawnLook(page, 'C2')).bg).toBe('#f4c7c3');
    await page.getByTestId('side-panel-close').click();
    await clickCell(page, 'F9');
    await page.screenshot({ path: shotPath(testInfo, 'rules-sales-colours.png') });

    // A new number changes its colour at once.
    await goTo(page, 'B3');
    await page.keyboard.type('200');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await drawnLook(page, 'B3')).bg).toBe('#57bb8a');
  });
});

test.describe('in a dark theme', () => {
  test.setTimeout(240_000);
  test.use({ colorScheme: 'dark' });

  test('checkboxes, lists, colours, a chart and a comment read well', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Night');
    await typeTable(page, 'A1', [
      ['Task', 'Hours', 'Done', 'Status'],
      ['Design', '12', '', 'Done'],
      ['Build', '30', '', 'Doing'],
      ['Test', '8', '', 'Open'],
    ]);
    await dragCells(page, 'C2', 'C4');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-checkbox').click();
    await page.getByTestId('side-panel-close').click();
    await goTo(page, 'C2');
    await page.keyboard.press('Space');
    await dragCells(page, 'D2', 'D4');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-list').click();
    await page.getByTestId('side-panel-close').click();
    await dragCells(page, 'B2', 'B4');
    await page.getByTestId('sheet-conditional').click();
    await page.getByTestId('format-add').click();
    await page.getByTestId('format-scale').click();
    await page.getByTestId('side-panel-close').click();
    await clickCell(page, 'A3', { button: 'right' });
    await page.getByTestId('menu-comment').click();
    await page.getByTestId('comment-new').fill('Halfway there');
    await page.getByTestId('comment-send').click();
    await dragCells(page, 'A1', 'B4');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-chart').click();
    await page.getByTestId('chart-title').fill('Hours');
    await page.getByTestId('chart-title').press('Enter');
    await page.getByTestId('side-panel-close').click();
    // The settings scrolled the chart into view beside them; back to the start of the table.
    await page.locator('[data-testid="sheet-grid"] [data-scrollable]').evaluate((element) => element.scrollTo(0, 0));
    await expect.poll(() => page.locator('[data-testid="sheet-grid"] [data-scrollable]').evaluate(element => element.scrollLeft)).toBe(0);
    // The grid may still be settling after the scroll, so the click is repeated until it lands on the cell.
    await expect(async () => {
      await clickCell(page, 'A3');
      await expect(page.getByTestId('comment-card')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.screenshot({ path: shotPath(testInfo, 'dark-everything.png') });
    await expectCell(page, 'C2', 'TRUE');
  });
});
