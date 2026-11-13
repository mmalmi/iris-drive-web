import { expect, type Page } from './fixtures';

/** The handle the grid leaves on the page in test mode. */
interface SheetHandle {
  text(row: number, col: number): string;
  style(row: number, col: number): Record<string, string | number>;
  box(row: number, col: number): { x: number; y: number; width: number; height: number; headerWidth: number; left: number; top: number } | null;
}

function position(name: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(name);
  if (!match) throw new Error(`Not a cell name: ${name}`);
  let col = 0;
  for (const letter of match[1]) col = col * 26 + (letter.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/** Creates a spreadsheet in the folder that is open and waits for its grid. */
export async function createSpreadsheet(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-sheet').filter({ visible: true }).first().click();
  await page.getByPlaceholder('Spreadsheet name...').fill(title);
  await page.getByPlaceholder('Spreadsheet name...').press('Enter');
  await expect(page.getByTestId('document-title')).toHaveText(title, { timeout: 30_000 });
  await waitForGrid(page);
}

export async function waitForGrid(page: Page): Promise<void> {
  await expect(page.getByTestId('sheet-grid')).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __sheet?: SheetHandle }).__sheet?.box(0, 0)), undefined, { timeout: 30_000 });
}

/** The text a cell shows. */
export async function cellText(page: Page, name: string): Promise<string> {
  const { row, col } = position(name);
  return page.evaluate(([r, c]) => (window as unknown as { __sheet: SheetHandle }).__sheet.text(r, c), [row, col]);
}

/** How a cell looks: b, i, s for bold, italic, strikethrough; c and bg for colours; a, w, nf. */
export async function cellStyle(page: Page, name: string): Promise<Record<string, string | number>> {
  const { row, col } = position(name);
  return page.evaluate(([r, c]) => (window as unknown as { __sheet: SheetHandle }).__sheet.style(r, c), [row, col]);
}

export async function expectCell(page: Page, name: string, text: string): Promise<void> {
  await expect.poll(() => cellText(page, name), { timeout: 10_000, message: `cell ${name}` }).toBe(text);
}

/** Where a cell is on the page, in viewport pixels. */
export async function cellBox(page: Page, name: string): Promise<{ x: number; y: number; width: number; height: number; headerWidth: number; left: number; top: number }> {
  const { row, col } = position(name);
  const box = await page.evaluate(([r, c]) => (window as unknown as { __sheet: SheetHandle }).__sheet.box(r, c), [row, col]);
  if (!box) throw new Error(`Cell ${name} has no place on screen`);
  return box;
}

export async function cellCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
  const box = await cellBox(page, name);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function clickCell(page: Page, name: string, options: { button?: 'left' | 'right'; shift?: boolean } = {}): Promise<void> {
  const { x, y } = await cellCenter(page, name);
  if (options.shift) await page.keyboard.down('Shift');
  await page.mouse.click(x, y, { button: options.button });
  if (options.shift) await page.keyboard.up('Shift');
}

/** Clicks the header of a column ("C") or of a row ("7"). */
export async function clickHeader(page: Page, name: string, options: { button?: 'left' | 'right' } = {}): Promise<void> {
  const isColumn = /^[A-Z]+$/.test(name);
  const box = await cellBox(page, isColumn ? `${name}1` : `A${name}`);
  if (isColumn) await page.mouse.click(box.x + box.width / 2, box.top + 12, { button: options.button });
  else await page.mouse.click(box.left + box.headerWidth / 2, box.y + box.height / 2, { button: options.button });
}

/** Drags the small square at the corner of the selection to another cell. */
export async function dragFillHandle(page: Page, corner: string, to: string): Promise<void> {
  const from = await cellBox(page, corner);
  const end = await cellCenter(page, to);
  await page.mouse.move(from.x + from.width - 1, from.y + from.height - 1);
  await page.mouse.down();
  await page.mouse.move((from.x + from.width + end.x) / 2, (from.y + from.height + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

/** Drags from the middle of one cell to the middle of another. */
export async function dragCells(page: Page, from: string, to: string): Promise<void> {
  const start = await cellCenter(page, from);
  const end = await cellCenter(page, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
}

/** Jumps to a cell by typing its name into the box left of the formula bar. */
export async function goTo(page: Page, name: string): Promise<void> {
  const box = page.getByTestId('sheet-name-box');
  await box.click();
  await box.fill(name);
  await box.press('Enter');
  await expect(page.getByTestId('sheet-active-cell')).toHaveAttribute('data-cell', name);
}

/**
 * Types rows of values starting at a cell, the way a person fills in a
 * table: Tab between cells, Enter at the end of each row.
 */
export async function typeTable(page: Page, start: string, rows: string[][]): Promise<void> {
  await goTo(page, start);
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      if (row[index] !== '') await page.keyboard.type(row[index]);
      await page.keyboard.press(index === row.length - 1 ? 'Enter' : 'Tab');
    }
  }
}

export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
}

export function activeCell(page: Page) {
  return page.getByTestId('sheet-active-cell');
}

/** Where hands-on screenshots go: SHEETS_SHOTS when set, else the test's own output folder. */
export function shotPath(testInfo: { outputPath: (name: string) => string }, name: string): string {
  const folder = process.env.SHEETS_SHOTS;
  return folder ? `${folder}/${name}` : testInfo.outputPath(name);
}

/**
 * A finger on the screen: pressed at the first point, held for `holdMs`,
 * moved through the others and lifted. Needs a context with touch.
 */
export async function touchPath(page: Page, points: Array<{ x: number; y: number }>, holdMs = 0): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const at = (point: { x: number; y: number }) => [{ x: Math.round(point.x), y: Math.round(point.y), id: 1 }];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(points[0]) });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    for (let step = 1; step <= 4; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at({ x: from.x + ((to.x - from.x) * step) / 4, y: from.y + ((to.y - from.y) * step) / 4 }),
      });
    }
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

/** Taps a cell with a finger. */
export async function tapCell(page: Page, name: string): Promise<void> {
  const { x, y } = await cellCenter(page, name);
  await page.touchscreen.tap(x, y);
}
