import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellBox,
  cellCenter,
  createSpreadsheet,
  expectCell,
  shotPath,
  tapCell,
  touchPath,
  typeTable,
} from './sheets.helpers';

/** Stands in for the browser's visual viewport, so a test can pretend an on-screen keyboard opened. */
async function fakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fake = new EventTarget() as EventTarget & Record<string, number>;
    Object.assign(fake, { offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1, width: innerWidth, height: innerHeight });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    (window as unknown as { __viewport: typeof fake }).__viewport = fake;
  });
}

async function showKeyboard(page: Page, height: number): Promise<number> {
  return page.evaluate((keyboard) => {
    const fake = (window as unknown as { __viewport: EventTarget & Record<string, number> }).__viewport;
    fake.height = innerHeight - keyboard;
    fake.dispatchEvent(new Event('resize'));
    return fake.height;
  }, height);
}

test.describe('a spreadsheet on a phone', () => {
  test.setTimeout(240_000);
  test.use({
    viewport: { width: 390, height: 760 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('a finger selects, stretches, fills, opens the menu, resizes and types above the keyboard', async ({ page, relayUrl }, testInfo) => {
    await fakeKeyboard(page);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Phone');
    await typeTable(page, 'A1', [
      ['Item', 'Cost'],
      ['Tea', '3'],
      ['Bread', '4'],
      ['Milk', '2'],
    ]);

    // A tap selects; round handles show at two corners.
    await tapCell(page, 'A2');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A2');
    await page.screenshot({ path: shotPath(testInfo, 'touch-handles.png') });

    // Dragging the lower handle stretches the selection.
    const a2 = await cellBox(page, 'A2');
    await touchPath(page, [{ x: a2.x + a2.width - 1, y: a2.y + a2.height - 1 }, await cellCenter(page, 'B4')]);
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A2:B4');
    // And the upper one from the other side.
    await touchPath(page, [{ x: a2.x - 1, y: a2.y - 1 }, await cellCenter(page, 'B3')]);
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'B3:B4');

    // A long press inside the selection opens the menu for it, with room for a finger.
    await touchPath(page, [await cellCenter(page, 'B4')], 700);
    const menu = page.getByTestId('sheet-menu');
    await expect(menu).toBeVisible();
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'B3:B4');
    for (const id of ['menu-edit', 'menu-cut', 'menu-copy', 'menu-paste', 'menu-fill-down', 'menu-insert-row-above', 'menu-delete-row']) {
      await expect(menu.getByTestId(id)).toBeVisible();
    }
    await expect(menu.getByTestId('menu-fill-right')).toHaveCount(0);
    expect((await menu.getByTestId('menu-copy').boundingBox())?.height).toBeGreaterThanOrEqual(40);
    await page.screenshot({ path: shotPath(testInfo, 'touch-menu.png') });
    await menu.getByTestId('menu-fill-down').tap();
    await expectCell(page, 'B4', '4');

    // Outside the selection, it selects the cell it is on first.
    await touchPath(page, [await cellCenter(page, 'B6')], 700);
    await expect(menu).toBeVisible();
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'B6');
    await expect(menu.getByTestId('menu-fill-down')).toHaveCount(0);
    await menu.getByTestId('menu-edit').tap();
    await page.keyboard.type('=SUM(B2:B4)');
    await page.keyboard.press('Enter');
    await expectCell(page, 'B6', '11');

    // The fill square off the selection's corner continues a series.
    await typeTable(page, 'C1', [['1'], ['2']]);
    await tapCell(page, 'C1');
    const c1 = await cellBox(page, 'C1');
    await touchPath(page, [{ x: c1.x + c1.width - 1, y: c1.y + c1.height - 1 }, await cellCenter(page, 'C2')]);
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C1:C2');
    const c2 = await cellBox(page, 'C2');
    expect(c2.x + c2.width + 24).toBeLessThan(390);
    await touchPath(page, [{ x: c2.x + c2.width + 16, y: c2.y + c2.height + 16 }, await cellCenter(page, 'C5')]);
    await expectCell(page, 'C5', '5');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'C1:C5');
    await page.screenshot({ path: shotPath(testInfo, 'touch-filled.png') });

    // A finger on the border between two column headers resizes.
    const a1 = await cellBox(page, 'A1');
    const before = a1.width;
    await touchPath(page, [{ x: a1.x + a1.width - 2, y: a1.top + 12 }, { x: a1.x + a1.width + 58, y: a1.top + 12 }]);
    await expect.poll(async () => (await cellBox(page, 'A1')).width).toBeGreaterThan(before + 40);

    // Typing near the bottom: the cell stays above the keyboard.
    const visibleTop = await showKeyboard(page, 330);
    let low = 'A10';
    for (let row = 30; row > 2; row -= 1) {
      const box = await cellBox(page, `A${row}`);
      if (box.y + box.height < 760 - 60) {
        low = `A${row}`;
        break;
      }
    }
    await tapCell(page, low);
    await tapCell(page, low);
    const editor = page.getByTestId('sheet-cell-editor');
    await expect(editor).toHaveClass(/visible/);
    await expect.poll(async () => {
      const box = await editor.boundingBox();
      return box ? box.y + box.height : 9999;
    }).toBeLessThanOrEqual(visibleTop);
    await page.keyboard.type('Above');
    await page.screenshot({ path: shotPath(testInfo, 'touch-keyboard.png') });
    await page.keyboard.press('Enter');
    await expectCell(page, low, 'Above');
  });
});
