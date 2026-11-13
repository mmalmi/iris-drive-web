import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { flushPendingPublishes } from './test-utils';
import {
  cellBox,
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

interface Placed {
  id: string;
  kind: string;
  row: number;
  col: number;
  dx: number;
  dy: number;
  width: number;
  height: number;
  file?: string;
  url?: string;
  title?: string;
  type?: string;
}

/** The pictures and charts on the sheet in view, from the page. */
function objects(page: Page): Promise<Placed[]> {
  return page.evaluate(async () => {
    const { listObjects } = await import('/src/lib/sheets/objects.ts');
    const ctl = (window as unknown as { __sheet: { ctl: { sheet: never; media: { urlOf(file: string): string | undefined } | null } } }).__sheet.ctl;
    return listObjects(ctl.sheet).map((object) => {
      const content = object.content as { kind: string; file?: string; title?: string; type?: string };
      return {
        id: object.id,
        kind: content.kind,
        row: object.row,
        col: object.col,
        dx: object.placement.dx,
        dy: object.placement.dy,
        width: object.placement.width,
        height: object.placement.height,
        file: content.file,
        url: content.file ? ctl.media?.urlOf(content.file) : undefined,
        title: content.title,
        type: content.type,
      };
    });
  });
}

/** Puts a picture of a coloured square on the clipboard, as a screenshot tool would. */
async function copyPicture(page: Page, color = '#e8590c'): Promise<void> {
  await page.evaluate(async (fill) => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 80;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = fill;
    context.fillRect(0, 0, 120, 80);
    context.fillStyle = '#ffffff';
    context.fillRect(20, 20, 40, 40);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(png => resolve(png as Blob), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, color);
}

test.describe('pictures, charts and pasting from other apps', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a pasted screenshot floats over the grid, moves, resizes, copies out and is undone', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Pictures');
    await typeTable(page, 'A1', [['Logo below']]);

    await copyPicture(page);
    await goTo(page, 'B3');
    await page.keyboard.press('ControlOrMeta+v');
    const picture = page.getByTestId('sheet-picture');
    await expect(picture).toBeVisible({ timeout: 30_000 });
    await expect(picture.locator('img')).toHaveJSProperty('complete', true);
    let [placed] = await objects(page);
    expect(placed).toMatchObject({ kind: 'picture', row: 2, col: 1, width: 120, height: 80 });
    expect(placed.file).toMatch(/\.png$/);
    // Selected at once, with handles to pull.
    await expect(picture.locator('[data-handle="se"]')).toBeVisible();
    await page.screenshot({ path: shotPath(testInfo, 'media-pasted-picture.png') });
    // It has the keyboard: Delete takes it away, and undo brings it back.
    await page.keyboard.press('Delete');
    await expect(picture).toHaveCount(0);
    await expectCell(page, 'A1', 'Logo below');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(picture).toBeVisible();

    // Dragged to D6.
    const from = await picture.boundingBox();
    const d6 = await cellBox(page, 'D6');
    if (!from) throw new Error('No picture on screen');
    await page.mouse.move(from.x + 30, from.y + 30);
    await page.mouse.down();
    await page.mouse.move(d6.x + 40, d6.y + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await objects(page))[0]).toMatchObject({ row: 5, col: 3 });

    // Pulled larger by its corner, keeping its shape.
    const box = await page.locator('[data-handle="se"]').boundingBox();
    if (!box) throw new Error('No handle');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await objects(page))[0].width).toBeGreaterThan(200);
    [placed] = await objects(page);
    expect(Math.abs(placed.width / placed.height - 1.5)).toBeLessThan(0.05);

    // Rows added above take it down with its cells.
    await clickCell(page, 'A2');
    await page.getByTestId('sheet-rows-columns').click();
    await page.getByTestId('menu-insert-row-above').click();
    await expect.poll(async () => (await objects(page))[0].row).toBe(6);

    // Copied out as a picture for other apps.
    await picture.click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.read())[0]?.types ?? [])).toContain('image/png');

    // Deleted with the key, back with undo.
    await picture.click();
    await page.keyboard.press('Delete');
    await expect(picture).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(picture).toBeVisible();

    // And pasted again from the clipboard: a second one.
    await goTo(page, 'H2');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(picture).toHaveCount(2, { timeout: 30_000 });
    await expectSaved(page);

    // Still there after opening it again.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expect(picture).toHaveCount(2, { timeout: 60_000 });
    await expect(picture.first().locator('img')).toHaveJSProperty('complete', true);
    await page.screenshot({ path: shotPath(testInfo, 'media-after-reload.png') });
  });

  test('a sales table gets a chart that follows its cells', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Sales');
    await typeTable(page, 'A1', [
      ['Month', 'North', 'South'],
      ['Jan', '120', '80'],
      ['Feb', '150', '95'],
      ['Mar', '90', '130'],
      ['Apr', '170', '110'],
    ]);
    await dragCells(page, 'A1', 'C5');
    await page.getByTestId('sheet-insert').click();
    await page.getByTestId('insert-chart').click();
    const chart = page.getByTestId('sheet-chart');
    await expect(chart).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('chart-panel')).toBeVisible();
    await expect(chart.locator('svg')).toContainText('North');
    await expect(chart.locator('svg')).toContainText('Apr');
    expect(await objects(page)).toMatchObject([{ kind: 'chart', type: 'column', row: 0, col: 3 }]);

    await page.getByTestId('chart-title').fill('Sales by month');
    await page.getByTestId('chart-title').press('Enter');
    await expect(chart.locator('svg')).toContainText('Sales by month');
    await page.screenshot({ path: shotPath(testInfo, 'media-chart-columns.png') });
    await page.getByTestId('chart-type-line').click();
    await expect(chart.locator('svg path[stroke-linejoin="round"]')).toHaveCount(2);
    await page.getByTestId('side-panel-close').click();
    await expect(page.getByTestId('chart-panel')).toHaveCount(0);

    // A changed number shows at once.
    await goTo(page, 'B3');
    await page.keyboard.type('400');
    await page.keyboard.press('Enter');
    await expect(chart.locator('svg title', { hasText: 'North, Feb: 400' })).toHaveCount(1);
    await page.screenshot({ path: shotPath(testInfo, 'media-chart-line.png') });

    // Undo takes the number back, then the kind of chart, then the title.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(chart.locator('svg title', { hasText: 'North, Feb: 150' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(chart.locator('svg path[stroke-linejoin="round"]')).toHaveCount(0);

    // Double-click opens its settings again; a pie of the first series.
    await chart.dblclick();
    await page.getByTestId('chart-type-pie').click();
    await expect(chart.locator('svg')).toContainText('%');
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expect(chart.locator('svg')).toContainText('Sales by month', { timeout: 60_000 });
  });

  test('a table from another app keeps its looks, and copied cells carry pictures to another spreadsheet', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Source');

    // As Google Sheets puts a table on the clipboard.
    const html = '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>'
      + '<table><tbody><tr><td colspan="2" style="font-weight:bold;background-color:#d9ead3;text-align:center;">Team</td></tr>'
      + '<tr><td>Ada</td><td data-sheets-value=\'{"1":3,"3":91.5}\'>91.5</td></tr>'
      + '<tr><td style="color:#cc0000;font-style:italic">Grace</td><td>88</td></tr></tbody></table>';
    await page.evaluate(async (markup) => {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([markup], { type: 'text/html' }),
        'text/plain': new Blob(['Team\nAda\t91.5\nGrace\t88'], { type: 'text/plain' }),
      })]);
    }, html);
    await goTo(page, 'B2');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCell(page, 'B2', 'Team');
    await expectCell(page, 'C3', '91.5');
    await expectCell(page, 'B4', 'Grace');
    const looks = await page.evaluate(() => {
      const handle = (window as unknown as { __sheet: { style(r: number, c: number): Record<string, unknown>; ctl: { sheet: { mergeAt(r: number, c: number): unknown } } } }).__sheet;
      return { team: handle.style(1, 1), grace: handle.style(3, 1), merged: handle.ctl.sheet.mergeAt(1, 1) };
    });
    expect(looks.team).toMatchObject({ b: 1, bg: '#d9ead3', a: 'c' });
    expect(looks.team.bt).toBeUndefined();
    expect(looks.grace).toMatchObject({ i: 1, c: '#cc0000' });
    expect(looks.merged).toMatchObject({ r1: 1, c1: 1, r2: 1, c2: 2 });

    // A picture over the table, copied together with its cells.
    await copyPicture(page, '#1c7ed6');
    await goTo(page, 'C4');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByTestId('sheet-picture')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sheet-picture').locator('img')).toHaveJSProperty('complete', true);
    const [source] = await objects(page);
    await dragCells(page, 'B2', 'C4');
    await page.keyboard.press('ControlOrMeta+c');
    await page.screenshot({ path: shotPath(testInfo, 'media-paste-table.png') });
    await expectSaved(page);
    await flushPendingPublishes(page);

    // Into a second spreadsheet in the same Drive.
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createSpreadsheet(page, 'Target');
    await goTo(page, 'A1');
    await page.keyboard.press('ControlOrMeta+v');
    await expectCell(page, 'A1', 'Team');
    await expectCell(page, 'B2', '91.5');
    await expect(page.getByTestId('sheet-picture')).toBeVisible({ timeout: 30_000 });
    const [copy] = await objects(page);
    expect(copy).toMatchObject({ kind: 'picture', row: 2, col: 1 });
    // Stored again among this spreadsheet's own attachments.
    expect(copy.file).not.toBe(source.file);
    expect(copy.url).toBeTruthy();
    await expectSaved(page);
    const stored = await page.evaluate(async () => {
      const { parseRoute } = await import('/src/utils/route.ts');
      const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
      const { getTree } = await import('/src/store.ts');
      const route = parseRoute();
      const root = getTreeRootSync(route.npub, route.treeName);
      const folder = root && await getTree().resolvePath(root, [...route.path, 'attachments']);
      return folder ? (await getTree().listDirectory(folder.cid)).map(entry => entry.name) : [];
    });
    expect(stored).toContain(copy.file);
    await page.screenshot({ path: shotPath(testInfo, 'media-other-spreadsheet.png') });
  });
});
