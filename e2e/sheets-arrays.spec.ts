import fs from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellBox,
  createSpreadsheet,
  dragCells,
  dragFillHandle,
  expectCell,
  expectSaved,
  goTo,
  shotPath,
  typeTable,
  waitForGrid,
} from './sheets.helpers';

async function enter(page: Page, cell: string, text: string): Promise<void> {
  await goTo(page, cell);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function expectCells(page: Page, cells: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(cells)) await expectCell(page, name, text);
}

/**
 * Formulas whose result fills several cells, as in Google Sheets: the
 * formula sits in one cell and its values fill the cells beside and below.
 */
test.describe('formulas that fill several cells', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('UNIQUE, FILTER, SORT, SPLIT and SEQUENCE fill cells, follow changes and come back after a reload', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Fruit');
    await typeTable(page, 'A1', [
      ['Fruit', 'Kg'],
      ['Pear', '5'],
      ['Apple', '3'],
      ['Pear', '2'],
      ['Fig', '8'],
    ]);

    await enter(page, 'D1', '=UNIQUE(A2:A5)');
    await enter(page, 'E1', '=FILTER(A2:B5,B2:B5>2)');
    await enter(page, 'H1', '=SORT($B$2:$B$5,1,FALSE)');
    await enter(page, 'I1', '=SUM(H1:H9)');
    await enter(page, 'A8', '=SPLIT("red,green,blue",",")');
    await enter(page, 'A10', '=SEQUENCE(2,3)');
    await expectCells(page, {
      D1: 'Pear', D2: 'Apple', D3: 'Fig', D4: '',
      E1: 'Pear', F1: '5', E2: 'Apple', F2: '3', E3: 'Fig', F3: '8', E4: '',
      H1: '8', H2: '5', H3: '3', H4: '2', I1: '18',
      A8: 'red', B8: 'green', C8: 'blue',
      A10: '1', C10: '3', A11: '4', C11: '6',
    });

    // A filled cell holds no formula of its own: the bar shows the one that fills it, greyed.
    const bar = page.getByTestId('sheet-formula-input');
    await goTo(page, 'D2');
    await expect(bar).toHaveValue('=UNIQUE(A2:A5)');
    await expect(bar).toHaveAttribute('data-spilled', 'true');
    await page.screenshot({ path: shotPath(testInfo, 'arrays-filled.png') });
    await goTo(page, 'D1');
    await expect(bar).toHaveValue('=UNIQUE(A2:A5)');
    await expect(bar).not.toHaveAttribute('data-spilled', 'true');

    // Changing what they read changes the results, and the formulas reading those.
    await enter(page, 'B5', '1');
    await enter(page, 'A3', 'Kiwi');
    await expectCells(page, {
      D1: 'Pear', D2: 'Kiwi', D3: 'Fig',
      E1: 'Pear', E2: 'Kiwi', E3: '', F3: '',
      H1: '5', H4: '1', I1: '11',
    });

    // Something typed where a result would go stops it, and nothing is overwritten.
    await enter(page, 'D3', 'mine');
    await expectCells(page, { D1: '#REF!', D2: '', D3: 'mine' });
    await goTo(page, 'D1');
    await expect(page.getByTestId('sheet-status')).toContainText('Array result was not expanded because it would overwrite data in D3');
    await page.screenshot({ path: shotPath(testInfo, 'arrays-blocked.png') });
    await goTo(page, 'D3');
    await page.keyboard.press('Delete');
    await expectCells(page, { D1: 'Pear', D2: 'Kiwi', D3: 'Fig' });

    // Copying the formula's cell copies the formula, which fills cells where it lands.
    await goTo(page, 'H1');
    await page.keyboard.press('ControlOrMeta+c');
    await goTo(page, 'J1');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCells(page, { J1: '5', J2: '3', J3: '2', J4: '1' });
    await goTo(page, 'J1');
    await expect(bar).toHaveValue('=SORT($B$2:$B$5,1,FALSE)');

    // Only the formulas are saved; the values come back from them.
    await expectSaved(page);
    await page.reload();
    await waitForGrid(page);
    await expectCells(page, {
      D1: 'Pear', D2: 'Kiwi', D3: 'Fig',
      E1: 'Pear', F2: '3', E3: '',
      H1: '5', I1: '11', J4: '1',
      A8: 'red', C8: 'blue',
      A11: '4', C11: '6',
    });
  });

  test('the cells a result fills are moved over, filled beside, outlined and exported as a formula', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Spill');
    await enter(page, 'A1', '=SEQUENCE(6)');
    await expectCells(page, { A1: '1', A6: '6' });

    // Ctrl+arrows go to the end of the values, as over typed data.
    await goTo(page, 'A1');
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A6');
    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1:A6');

    // Double-clicking the fill handle beside them fills as far as they go.
    await enter(page, 'B1', '=A1*10');
    await goTo(page, 'B1');
    const b1 = await cellBox(page, 'B1');
    await page.mouse.dblclick(b1.x + b1.width - 1, b1.y + b1.height - 1);
    await expectCells(page, { B2: '20', B6: '60', B7: '' });

    // Dragging the fill handle from them continues their values.
    await dragCells(page, 'A5', 'A6');
    await dragFillHandle(page, 'A6', 'A8');
    await expectCells(page, { A7: '7', A8: '8' });

    // A thin line goes round the whole result while one of its cells is active.
    await goTo(page, 'A3');
    await expect.poll(() => accentRightOf(page, 'A5')).toBe(true);
    await page.screenshot({ path: shotPath(testInfo, 'arrays-outline.png') });
    await goTo(page, 'C3');
    await expect.poll(() => accentRightOf(page, 'A5')).toBe(false);

    // Out to Excel as a dynamic array, and back in as the formula again.
    await page.getByTestId('sheet-more').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('sheet-download-xlsx').click();
    const file = testInfo.outputPath('Spill.xlsx');
    await (await downloading).saveAs(file);
    const files = unzipSync(new Uint8Array(fs.readFileSync(file)));
    const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<c r="A1" cm="1"><f t="array" ref="A1:A6">_xlfn.SEQUENCE(6)</f><v>1</v></c>');
    expect(files['xl/metadata.xml']).toBeTruthy();
    await page.getByTestId('sheet-csv-input').setInputFiles(file);
    await expect(page.getByTestId('sheet-tab')).toHaveCount(2);
    await expectCells(page, { A1: '1', A6: '6', A8: '8', B6: '60' });
    await goTo(page, 'A4');
    const bar = page.getByTestId('sheet-formula-input');
    await expect(bar).toHaveValue('=SEQUENCE(6)');
    await expect(bar).toHaveAttribute('data-spilled', 'true');
  });
});

/** Whether the grid draws its accent colour on the line right of a cell, half way down it. */
async function accentRightOf(page: Page, name: string): Promise<boolean> {
  const box = await cellBox(page, name);
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="sheet-grid"] canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return false;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    const { data } = context.getImageData(Math.round((x - 3) * ratio), Math.round(y * ratio), Math.ceil(6 * ratio), 1);
    // The accent is a violet: much more blue than green.
    for (let index = 0; index < data.length; index += 4) if (data[index + 2] > 200 && data[index + 1] < 150) return true;
    return false;
  }, { x: box.x + box.width - 1 - box.left, y: box.y + box.height / 2 - box.top });
}
