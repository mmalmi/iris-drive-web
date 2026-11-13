import fs from 'node:fs';
import { expect, test, type Page } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellBox,
  cellCenter,
  cellStyle,
  cellText,
  clickCell,
  clickHeader,
  createSpreadsheet,
  dragCells,
  dragFillHandle,
  expectCell,
  expectSaved,
  goTo,
  typeTable,
  waitForGrid,
} from './sheets.helpers';

/** Adds a second browser as another device of the owner's Drive. */
async function linkSecondDevice(owner: Page, device: Page, relayUrl: string, profileId: string): Promise<void> {
  await prepareFreshSession(device, relayUrl);
  await device.goto('/#/users', { waitUntil: 'domcontentloaded' });
  await device.getByTestId('add-existing-profile').click();
  await expect(device.getByTestId('device-approval-qr')).toBeVisible({ timeout: 30_000 });
  const approvalUrl = await device.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:drive:pending-device-approval') ?? 'null') as { url?: string } | null;
    return stored?.url ?? '';
  });
  expect(approvalUrl).toContain('approve-device');
  await owner.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await owner.getByTestId('device-approval-input').fill(approvalUrl);
  await owner.getByTestId('approve-device-request').click();
  await expect(owner.getByTestId('user-key-row')).toHaveCount(2, { timeout: 60_000 });
  await expect.poll(async () => device.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.status === 'active' ? stored.profileId : null;
  }), { timeout: 90_000 }).toBe(profileId);
}

test.describe('working in a spreadsheet', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('cells can be formatted, and rows and columns resized, moved and frozen', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Looks');
    await typeTable(page, 'A1', [
      ['Project', 'Due', 'Budget', 'Spent', 'Share', 'Notes'],
      ['Website', '2026-12-01', '12000', '8450.5', '=D2/C2', 'Waiting for the final copy from marketing before launch'],
      ['App', '15.2.2027', '48000', '51200', '=D3/C3', 'Over budget'],
      ['Total', '', '=SUM(C2:C3)', '=SUM(D2:D3)', '=D4/C4', ''],
    ]);

    // Header: bold, a dark fill (so its text turns light) and centred.
    await dragCells(page, 'A1', 'F1');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.getByTestId('sheet-fill-color').click();
    await page.locator('[data-color="#4527a0"]').click();
    await page.getByRole('button', { name: 'Align centre' }).click();
    expect(await cellStyle(page, 'C1')).toEqual({ b: 1, bg: '#4527a0', a: 'c' });

    // Money and percentages.
    await dragCells(page, 'C2', 'D4');
    await page.getByTestId('sheet-number-format').selectOption('euro');
    await expectCell(page, 'D2', '€8,450.50');
    await dragCells(page, 'E2', 'E4');
    await page.getByTestId('sheet-number-format').selectOption('percent');
    await expectCell(page, 'E2', '70.42%');
    await page.getByRole('button', { name: 'Fewer decimal places' }).click();
    await expectCell(page, 'E2', '70.4%');
    await expectCell(page, 'E4', '99.4%');
    // Dates keep the way they were typed and can be shown another way.
    await expectCell(page, 'B3', '15.2.2027');
    await clickCell(page, 'B3');
    await page.getByTestId('sheet-number-format').selectOption('date');
    await expectCell(page, 'B3', '2027-02-15');

    // Colour, italic, strikethrough; then undo of a look, and clearing all of them.
    await clickCell(page, 'D3');
    await page.getByTestId('sheet-text-color').click();
    await page.locator('[data-color="#e03131"]').click();
    expect(await cellStyle(page, 'D3')).toMatchObject({ c: '#e03131' });
    await clickCell(page, 'F3');
    await page.getByRole('button', { name: 'Italic' }).click();
    await page.keyboard.press('ControlOrMeta+Shift+x');
    expect(await cellStyle(page, 'F3')).toEqual({ i: 1, s: 1 });
    await page.keyboard.press('ControlOrMeta+z');
    expect(await cellStyle(page, 'F3')).toEqual({ i: 1 });
    await page.getByRole('button', { name: 'Clear formatting' }).click();
    expect(await cellStyle(page, 'F3')).toEqual({});

    // Wrapping a long note makes its row taller.
    await clickCell(page, 'F2');
    const before = await cellBox(page, 'F2');
    await page.getByRole('button', { name: 'Wrap text' }).click();
    await expect.poll(async () => (await cellBox(page, 'F2')).height).toBeGreaterThan(before.height * 2);

    // Dragging a column border resizes it; a double-click fits it to its content.
    const a1 = await cellBox(page, 'A1');
    await page.mouse.move(a1.x + a1.width - 1, a1.top + 12);
    await page.mouse.down();
    await page.mouse.move(a1.x + a1.width + 60, a1.top + 12, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await cellBox(page, 'A1')).width).toBe(a1.width + 61);
    const f1 = await cellBox(page, 'F1');
    await page.mouse.dblclick(f1.x + f1.width - 1, f1.top + 12);
    await expect.poll(async () => (await cellBox(page, 'F1')).width).toBeGreaterThan(300);
    await expect.poll(async () => (await cellBox(page, 'F2')).height).toBe(before.height);
    await page.screenshot({ path: testInfo.outputPath('formatted.png') });

    // Moving a column takes its cells, looks and the formulas that read it along.
    await clickHeader(page, 'D', { button: 'right' });
    await page.getByTestId('menu-move-left').click();
    await expectCell(page, 'C1', 'Spent');
    await expectCell(page, 'E2', '70.4%');
    await goTo(page, 'E2');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=C2/D2');
    // A new column between them, then delete it again.
    await clickHeader(page, 'D', { button: 'right' });
    await page.getByTestId('menu-insert-col-left').click();
    await expectCell(page, 'E1', 'Budget');
    await expectCell(page, 'F2', '70.4%');
    await page.getByTestId('sheet-rows-columns').click();
    await page.getByTestId('menu-delete-col').click();
    await expectCell(page, 'D1', 'Budget');
    // A selected column can also be dragged to its new place by its header.
    await clickHeader(page, 'A');
    const from = await cellBox(page, 'A1');
    const to = await cellBox(page, 'C1');
    await page.mouse.move(from.x + from.width / 2, from.top + 12);
    await page.mouse.down();
    await page.mouse.move(to.x + 20, from.top + 12, { steps: 5 });
    await page.mouse.move(to.x + to.width - 10, from.top + 12, { steps: 5 });
    await page.screenshot({ path: testInfo.outputPath('dragging-column.png') });
    await page.mouse.up();
    await expectCell(page, 'A1', 'Due');
    await expectCell(page, 'C1', 'Project');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C:C');
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'A1', 'Project');

    // The first row stays in view when frozen.
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('sheet-freeze-row').click();
    const cell = await cellCenter(page, 'B3');
    await page.mouse.move(cell.x, cell.y);
    await page.mouse.wheel(0, 2400);
    await expect.poll(async () => (await cellBox(page, 'A101')).y).toBeLessThan(600);
    expect((await cellBox(page, 'A1')).y).toBe(a1.y);
    await page.screenshot({ path: testInfo.outputPath('frozen.png') });
  });

  test('dragging the corner continues a series, and several sheets work together', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Sheets');
    await typeTable(page, 'A1', [['1', 'Mon', '2026-01-30', 'Item 1', '10'], ['2', '', '', '', '20']]);
    await goTo(page, 'F1');
    await page.keyboard.type('=E1*2');
    await page.keyboard.press('Enter');

    await dragCells(page, 'A1', 'A2');
    await dragFillHandle(page, 'A2', 'A8');
    await expectCell(page, 'A8', '8');
    for (const column of ['B', 'C', 'D']) {
      await clickCell(page, `${column}1`);
      await dragFillHandle(page, `${column}1`, `${column}8`);
    }
    await expectCell(page, 'B3', 'Wed');
    await expectCell(page, 'B8', 'Mon');
    await expectCell(page, 'C4', '2026-02-02');
    await expectCell(page, 'D8', 'Item 8');
    // A double-click on the corner fills down beside the filled column; formulas move along.
    await dragCells(page, 'E1', 'E2');
    const e2 = await cellBox(page, 'E2');
    await page.mouse.dblclick(e2.x + e2.width - 1, e2.y + e2.height - 1);
    await expectCell(page, 'E8', '80');
    await clickCell(page, 'F1');
    const f1 = await cellBox(page, 'F1');
    await page.mouse.dblclick(f1.x + f1.width - 1, f1.y + f1.height - 1);
    await expectCell(page, 'F8', '160');
    await goTo(page, 'F8');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=E8*2');
    // One undo takes the whole fill back.
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'F8', '');
    await expectCell(page, 'F1', '20');
    await page.keyboard.press('ControlOrMeta+y');
    await expectCell(page, 'F8', '160');
    await page.screenshot({ path: testInfo.outputPath('filled.png') });

    // A second sheet whose formula points at cells of the first.
    await page.getByTestId('sheet-add-tab').click();
    await expect(page.getByTestId('sheet-tab')).toHaveCount(2);
    await page.keyboard.type('=SUM(');
    await page.getByTestId('sheet-tab').first().click();
    await dragCells(page, 'E1', 'E8');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=SUM(Sheet1!E1:E8');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('sheet-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expectCell(page, 'A1', '360');

    // Renaming the first sheet changes the formula's text, not its answer.
    await page.getByTestId('sheet-tab').first().dblclick();
    await page.getByTestId('sheet-tab-rename').fill('Data 2026');
    await page.getByTestId('sheet-tab-rename').press('Enter');
    await page.getByTestId('sheet-tab').nth(1).click();
    await goTo(page, 'A1');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue("=SUM('Data 2026'!E1:E8)");
    await expectCell(page, 'A1', '360');

    // Tabs can be reordered and copied; deleting the sheet a formula reads leaves an error.
    await page.getByTestId('sheet-tab-menu').click();
    await page.getByTestId('tab-move-left').click();
    await expect(page.getByTestId('sheet-tab').first()).toHaveText(/Sheet2/);
    await page.getByTestId('sheet-tab').nth(1).click({ button: 'right' });
    await page.getByTestId('tab-duplicate').click();
    await expect(page.getByTestId('sheet-tab')).toHaveCount(3);
    await expect(page.getByTestId('sheet-tab').nth(2)).toHaveText(/Data 2026 copy/);
    await expectCell(page, 'F8', '160');
    await page.getByTestId('sheet-tab').nth(1).click({ button: 'right' });
    page.once('dialog', dialog => void dialog.accept());
    await page.getByTestId('tab-delete').click();
    await expect(page.getByTestId('sheet-tab')).toHaveCount(2);
    await page.getByTestId('sheet-tab').first().click();
    await expectCell(page, 'A1', '#REF!');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('sheet-tab')).toHaveCount(3);
    await page.getByTestId('sheet-tab').first().click();
    await expectCell(page, 'A1', '360');
    await page.screenshot({ path: testInfo.outputPath('tabs.png') });
  });

  test('a CSV file comes in and goes out, and a shared link opens read-only for someone else', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Ledger');
    const lines = ['Date,Description,Amount,Paid', '2026-01-05,"Paper, pens",12.40,TRUE', '2026-01-09,"He said ""hi""",-3,FALSE'];
    for (let n = 0; n < 2000; n += 1) lines.push(`2026-03-${String((n % 28) + 1).padStart(2, '0')},Row ${n},${(n * 1.25).toFixed(2)},TRUE`);
    await page.getByTestId('sheet-csv-input').setInputFiles({ name: 'ledger 2026.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
    await expect(page.getByTestId('sheet-tab')).toHaveCount(2);
    await expect(page.getByTestId('sheet-tab').nth(1)).toHaveText(/ledger 2026/);
    await expectCell(page, 'B3', 'He said "hi"');
    await expectCell(page, 'A2', '2026-01-05');
    await expectCell(page, 'D2', 'TRUE');

    // A sum over the whole column answers at once and follows an edit two thousand rows down.
    await goTo(page, 'F1');
    await page.keyboard.type('=SUM(C:C)');
    await page.keyboard.press('Enter');
    const total = 9.4 + (1999 * 2000 / 2) * 1.25;
    await expectCell(page, 'F1', String(total));
    await page.keyboard.press('ControlOrMeta+End');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'F2003');
    await goTo(page, 'C2003');
    const started = Date.now();
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await expectCell(page, 'F1', String(total - 1999 * 1.25 + 1));
    expect(Date.now() - started).toBeLessThan(2000);

    const download = page.waitForEvent('download');
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('sheet-download-csv').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Ledger - ledger 2026.csv');
    const saved = fs.readFileSync(await file.path(), 'utf8').split('\r\n');
    expect(saved[1]).toBe('2026-01-05,"Paper, pens",12.4,TRUE,,');
    expect(saved[2]).toBe('2026-01-09,"He said ""hi""",-3,FALSE,,');
    expect(saved).toHaveLength(2004);

    await expectSaved(page);
    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(sharedUrl).toMatch(/#\/nhash1[a-z0-9]+\?doc=Ledger&kind=sheet$/);
    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(`${new URL(guest.url()).origin}/#${sharedUrl.split('#')[1]}`);
      await expect(guest.getByTestId('document-title')).toHaveText('Ledger', { timeout: 60_000 });
      await waitForGrid(guest);
      await expect(guest.getByTestId('document-view-only')).toBeVisible();
      await expect(guest.getByTestId('sheet-toolbar')).toHaveCount(0);
      await expect(guest.getByTestId('sheet-add-tab')).toHaveCount(0);
      await guest.getByTestId('sheet-tab').nth(1).click();
      await expectCell(guest, 'B3', 'He said "hi"');

      // Looking around, selecting and copying work; nothing can be changed.
      await clickCell(guest, 'B3');
      await expect(guest.getByTestId('sheet-formula-input')).toHaveValue('He said "hi"');
      await guest.keyboard.type('nope');
      await guest.keyboard.press('Enter');
      await guest.keyboard.press('ArrowUp');
      await guest.keyboard.press('Delete');
      await guest.keyboard.press('F2');
      await guest.keyboard.type('nope');
      await guest.keyboard.press('Enter');
      const b3 = await cellCenter(guest, 'B3');
      await guest.mouse.dblclick(b3.x, b3.y);
      await expect(guest.getByTestId('sheet-cell-editor')).toHaveCSS('opacity', '0');
      await expectCell(guest, 'B3', 'He said "hi"');
      await clickCell(guest, 'A2');
      await clickCell(guest, 'C3', { shift: true });
      await expect(activeCell(guest)).toHaveAttribute('data-cell', 'A2:C3');
      await guest.keyboard.press('ControlOrMeta+c');
      expect(await guest.evaluate(() => navigator.clipboard.readText())).toBe('2026-01-05\tPaper, pens\t12.4\n2026-01-09\t"He said ""hi"""\t-3');
      await guest.keyboard.press('ControlOrMeta+v');
      await expectCell(guest, 'A2', '2026-01-05');
      await clickCell(guest, 'B3', { button: 'right' });
      await expect(guest.getByTestId('sheet-menu').getByRole('menuitem')).toHaveCount(1);
      await guest.keyboard.press('Escape');
      await goTo(guest, 'F1');
      await expect(guest.getByTestId('sheet-formula-input')).toHaveValue('=SUM(C:C)');
      await guest.screenshot({ path: testInfo.outputPath('guest.png') });
    } finally {
      await guestContext.close();
    }
  });

  test('two tabs of one browser show each other\'s edits', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Tabs');
    await typeTable(page, 'A1', [['5', '=A1*2']]);
    await expectSaved(page);

    const second = await context.newPage();
    await second.goto(page.url());
    await waitForGrid(second);
    await expectCell(second, 'B1', '10');
    await expect(second.getByTestId('document-save-status')).toHaveText('Open in another tab');

    // What the second tab types shows in the first at once and is saved by it.
    await goTo(second, 'A1');
    await second.keyboard.type('7');
    await second.keyboard.press('Enter');
    await expectCell(page, 'B1', '14');
    await expectSaved(page);
    // Undo in one tab leaves the other tab's edits alone.
    await goTo(page, 'C1');
    await page.keyboard.type('mine');
    await page.keyboard.press('Enter');
    await expectCell(second, 'C1', 'mine');
    await second.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'A1', '5');
    await expectCell(page, 'C1', 'mine');
  });

  test('two devices change the same sheet at once and end up with the same result', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page);
    const deviceContext = await browser.newContext();
    try {
      const device = await deviceContext.newPage();
      await linkSecondDevice(page, device, relayUrl, owner.profileId);
      await page.goto(`/#/${owner.profileId}/main`);
      await createSpreadsheet(page, 'Trip');
      await typeTable(page, 'A1', [['Item', 'Cost'], ['Tent', '120'], ['Stove', '45'], ['Total', '=SUM(B2:B3)']]);
      await expectSaved(page);

      await device.goto(page.url());
      await waitForGrid(device);
      await expectCell(device, 'B4', '165');
      await expect(device.getByTestId('document-view-only')).toHaveCount(0);

      // One device inserts a row inside the summed range and fills it in,
      // while the other changes a cost and makes the header bold.
      await clickCell(device, 'A3', { button: 'right' });
      await device.getByTestId('menu-insert-row-above').click();
      await typeTable(device, 'A3', [['Maps', '15']]);
      await goTo(page, 'B2');
      await page.keyboard.type('130');
      await page.keyboard.press('Enter');
      await dragCells(page, 'A1', 'B1');
      await page.getByRole('button', { name: 'Bold' }).click();
      await expectSaved(page);
      await expectSaved(device);
      for (const side of [page, device]) {
        await expect.poll(
          async () => [await cellText(side, 'A3'), await cellText(side, 'B2'), await cellText(side, 'B5')],
          { timeout: 60_000 },
        ).toEqual(['Maps', '130', '190']);
        await expect.poll(() => cellStyle(side, 'B1'), { timeout: 30_000 }).toEqual({ b: 1 });
        await goTo(side, 'B5');
        await expect(side.getByTestId('sheet-formula-input')).toHaveValue('=SUM(B2:B4)');
      }
      await device.screenshot({ path: testInfo.outputPath('second-device.png') });

      // It is still there after a reload.
      await device.reload({ waitUntil: 'domcontentloaded' });
      await waitForGrid(device);
      await expectCell(device, 'B5', '190');
    } finally {
      await deviceContext.close();
    }
  });
});
