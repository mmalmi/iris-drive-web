import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { cellStyle, clickCell, createSpreadsheet, expectCell, expectSaved, goTo, shotPath, typeTable, waitForGrid } from './sheets.helpers';

/** Where a cell links to, as the grid draws it; null when it is plain text. */
async function linkAt(page: Page, name: string): Promise<string | null> {
  const match = /^([A-Z]+)(\d+)$/.exec(name)!;
  const col = match[1].charCodeAt(0) - 65;
  const row = Number(match[2]) - 1;
  return page.evaluate(([r, c]) => (window as unknown as { __sheet: { link(r: number, c: number): string | null } }).__sheet.link(r, c), [row, col]);
}

/**
 * Habits people bring from Google Sheets: links that open, the number
 * format keys, today's date from the keyboard, and coming back to the sheet
 * they were on.
 */
test.describe('what people used to Google Sheets reach for', () => {
  test.setTimeout(240_000);

  test('web addresses and HYPERLINK open from a chip under the cell', async ({ page, context, relayUrl }, testInfo) => {
    // Nothing leaves the machine: the addresses answer here.
    await context.route(/^https:\/\/(www\.)?(example\.com|iris\.to)\//, route => route.fulfill({ contentType: 'text/html', body: '<title>Opened</title>Opened' }));
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Reading list');
    await typeTable(page, 'A1', [
      ['Title', 'Where'],
      ['Report', 'https://example.com/report'],
      ['Home', 'www.iris.to'],
      ['Notes', 'see example.com for more'],
      ['Site', '=HYPERLINK("https://iris.to/about", "About Iris")'],
    ]);
    await expectCell(page, 'B5', 'About Iris');
    expect(await linkAt(page, 'B2')).toBe('https://example.com/report');
    expect(await linkAt(page, 'B3')).toBe('https://www.iris.to');
    expect(await linkAt(page, 'B5')).toBe('https://iris.to/about');
    // Words around an address keep the cell plain, as do the headings.
    expect(await linkAt(page, 'B4')).toBeNull();
    expect(await linkAt(page, 'A1')).toBeNull();

    // A cell with a link shows where it goes; the chip opens it in a new tab.
    const chip = page.getByTestId('sheet-link-chip');
    await clickCell(page, 'B2');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('href', 'https://example.com/report');
    await expect(chip).toHaveAttribute('target', '_blank');
    await expect(chip).toContainText('example.com/report');
    await page.screenshot({ path: shotPath(testInfo, 'habits-link-chip.png') });
    const [opened] = await Promise.all([context.waitForEvent('page'), chip.click()]);
    await opened.waitForLoadState();
    expect(opened.url()).toBe('https://example.com/report');
    await opened.close();

    // HYPERLINK shows its label and goes to its address.
    await clickCell(page, 'B5');
    await expect(chip).toHaveAttribute('href', 'https://iris.to/about');
    // Plain text and typing hide the chip.
    await clickCell(page, 'B4');
    await expect(chip).toHaveCount(0);
    await goTo(page, 'B2');
    await expect(chip).toBeVisible();
    await page.keyboard.press('F2');
    await expect(chip).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expectSaved(page);
  });

  test('number format keys, today\'s date from the keyboard, and the sheet that was open comes back', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Keys');
    await typeTable(page, 'A1', [['0.256', '1234.5', '45000']]);

    // Ctrl+Shift+5 percent, +4 currency, +1 number, +3 date, +2 time.
    await goTo(page, 'A1');
    await page.keyboard.press('ControlOrMeta+Shift+5');
    await expectCell(page, 'A1', '25.60%');
    await page.keyboard.press('ControlOrMeta+Shift+4');
    await expectCell(page, 'A1', '$0.26');
    await page.keyboard.press('ControlOrMeta+Shift+1');
    await expectCell(page, 'A1', '0.26');
    await goTo(page, 'B1');
    await page.keyboard.press('ControlOrMeta+Shift+1');
    await expectCell(page, 'B1', '1,234.50');
    await goTo(page, 'C1');
    await page.keyboard.press('ControlOrMeta+Shift+3');
    await expect.poll(async () => (await cellStyle(page, 'C1')).nf).toMatch(/yyyy-mm-dd$/);
    await expectCell(page, 'C1', '3/15/2023');
    await page.keyboard.press('ControlOrMeta+Shift+2');
    await expectCell(page, 'C1', '00:00:00');
    // Undone one key at a time.
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'C1', '3/15/2023');

    // Ctrl+; writes today's date, Ctrl+Shift+; the time, as typed text to confirm with Enter.
    // Written the way this browser writes dates (en-US here).
    const today = await page.evaluate(() => {
      const now = new Date();
      return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
    });
    await goTo(page, 'A3');
    await page.keyboard.press('ControlOrMeta+;');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue(today);
    await page.keyboard.press('Enter');
    await expectCell(page, 'A3', today);
    expect((await cellStyle(page, 'A3')).nf).toMatch(/yyyy-mm-dd$/);
    // In the middle of typing, it goes where the cursor is.
    await goTo(page, 'A4');
    await page.keyboard.type('Paid on ');
    await page.keyboard.press('ControlOrMeta+;');
    await page.keyboard.press('Enter');
    await expectCell(page, 'A4', `Paid on ${today}`);
    await goTo(page, 'A5');
    await page.keyboard.press('ControlOrMeta+Shift+;');
    await expect(page.getByTestId('sheet-cell-editor')).toHaveValue(/^\d{2}:\d{2}:\d{2}$/);
    await page.keyboard.press('Escape');

    // A second sheet, open when the page is loaded again and in another tab.
    await page.getByTestId('sheet-add-tab').click();
    await expect(page.getByTestId('sheet-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await typeTable(page, 'A1', [['Second sheet']]);
    await expectSaved(page);
    await page.reload();
    await waitForGrid(page);
    await expect(page.getByTestId('sheet-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expectCell(page, 'A1', 'Second sheet');
    const other = await context.newPage();
    await other.goto(page.url());
    await waitForGrid(other);
    await expect(other.getByTestId('sheet-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await other.close();
    // Going back to the first sheet is remembered as well.
    await page.getByTestId('sheet-tab').first().click();
    await page.reload();
    await waitForGrid(page);
    await expect(page.getByTestId('sheet-tab').first()).toHaveAttribute('aria-selected', 'true');
    await expectCell(page, 'B1', '1,234.50');
  });
});
