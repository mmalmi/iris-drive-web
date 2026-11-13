import fs from 'node:fs';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createPresentation, elements, expectSlidesSaved, sheet, shot, thumbs } from './slides.helpers';

async function blankSlide(page: Page): Promise<void> {
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-blank').click();
  await expect(elements(page)).toHaveCount(0);
}

/** Drags a thing on the page, held a share of the way along it, some pixels away, the way a hand does. */
async function dragBy(page: Page, selector: ReturnType<Page['locator']>, dx: number, dy: number, along = 0.15): Promise<void> {
  const box = (await selector.boundingBox())!;
  const x = box.x + box.width * (box.width > box.height ? along : 0.5);
  const y = box.y + box.height * (box.height > box.width ? along : 0.5);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Widths and heights of the cells as drawn, in slide units. */
async function cellSizes(page: Page): Promise<Array<{ w: number; h: number }>> {
  const scale = (await sheet(page).boundingBox())!.width / 1280;
  const cells = sheet(page).locator('[data-cell]');
  const boxes = await cells.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()).map(rect => ({ w: rect.width, h: rect.height })));
  return boxes.map(box => ({ w: Math.round(box.w / scale), h: Math.round(box.h / scale) }));
}

test.describe('tables that take shape', () => {
  test.setTimeout(240_000);

  test('columns are dragged wider, a heading is merged across, cells are picked, lined and cleared, and it all stays', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Table shapes');
    await blankSlide(page);
    const cells = sheet(page).locator('[data-cell]');
    const cellText = () => cells.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.trim()));

    await page.getByTestId('add-table').click();
    await page.getByTestId('table-3x3').click();
    await expect(cells).toHaveCount(9);
    for (const [index, word] of ['Plan', '', '', 'Who', 'What', 'When', 'Ada', 'Engine', 'Monday'].entries()) {
      if (index > 0) await page.keyboard.press('Tab');
      if (word) await page.keyboard.type(word);
    }
    await page.keyboard.press('Escape');
    const before = await cellSizes(page);
    expect(before[0]!.w).toBe(before[1]!.w);

    // The line between the first two columns is dragged right: the first gets wider, the second as much narrower.
    const scale = (await sheet(page).boundingBox())!.width / 1280;
    await dragBy(page, page.getByTestId('table-col-line').first(), 120 * scale, 0);
    const widened = await cellSizes(page);
    expect(widened[0]!.w - before[0]!.w).toBeGreaterThanOrEqual(115);
    expect(widened[0]!.w - before[0]!.w).toBeLessThanOrEqual(125);
    expect(widened[0]!.w + widened[1]!.w).toBeCloseTo(before[0]!.w + before[1]!.w, -1);
    expect(widened[2]!.w).toBe(before[2]!.w);
    // The line under the first row is dragged down: that row gets taller and the table with it.
    const tableBefore = (await elements(page, 'table').boundingBox())!;
    await dragBy(page, page.getByTestId('table-row-line').first(), 0, 40 * scale);
    const taller = await cellSizes(page);
    expect(taller[0]!.h - before[0]!.h).toBeGreaterThanOrEqual(36);
    expect(taller[4]!.h).toBe(before[4]!.h);
    expect((await elements(page, 'table').boundingBox())!.height).toBeGreaterThan(tableBefore.height + 30 * scale);
    await shot(page, 'table-01-resized');

    // A drag across the first row picks its cells; merged, they become one heading cell with the words of all.
    const first = (await cells.nth(0).boundingBox())!;
    const third = (await cells.nth(2).boundingBox())!;
    await page.mouse.move(first.x + 20, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(sheet(page).locator('.el-cell-picked')).toHaveCount(3);
    await shot(page, 'table-02-picked');
    await page.getByTestId('table-lines').click();
    await page.getByTestId('table-merge').click();
    await expect(cells).toHaveCount(7);
    expect((await cellText())[0]).toBe('Plan');
    const merged = await cellSizes(page);
    expect(merged[0]!.w).toBeCloseTo(widened[0]!.w + widened[1]!.w + widened[2]!.w, -1);
    // Undo splits it again, redo merges it.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(cells).toHaveCount(9);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(cells).toHaveCount(7);

    // Shift and a click picks the last two rows; they get a thick outer line in red.
    await cells.nth(1).click();
    await expect(cells.nth(1).locator('.ProseMirror')).toBeFocused();
    await page.keyboard.down('Shift');
    await cells.nth(6).click();
    await page.keyboard.up('Shift');
    await expect(sheet(page).locator('.el-cell-picked')).toHaveCount(6);
    await page.getByTestId('shape-border').click();
    await page.getByRole('button', { name: 'Thickness 4' }).click();
    await page.locator('[data-slides-popover] [data-colour="#e03131"]').click();
    await page.getByTestId('cell-lines-outer').click();
    await page.keyboard.press('Escape');
    const red = await sheet(page).locator('.el-table-lines line[stroke="#e03131"]').count();
    expect(red).toBe(10);
    // Cell fill for the picked cells only.
    await page.getByTestId('cell-fill').click();
    await page.locator('[data-slides-popover] [data-colour="#a5d8ff"]').click();
    await expect(cells.nth(1)).toHaveCSS('background-color', 'rgb(165, 216, 255)');
    await expect(cells.nth(0)).not.toHaveCSS('background-color', 'rgb(165, 216, 255)');
    await shot(page, 'table-03-lined');

    // From the keyboard: Shift and an arrow picks the cell beside, Delete empties the picked cells.
    await cells.nth(5).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(sheet(page).locator('.el-cell-picked')).toHaveCount(2);
    await page.keyboard.press('Delete');
    await expect.poll(cellText).toEqual(['Plan', 'Who', 'What', 'When', 'Ada', '', '']);
    await expect(elements(page, 'table')).toHaveCount(1);
    await page.keyboard.press('ControlOrMeta+z');
    expect(await cellText()).toEqual(['Plan', 'Who', 'What', 'When', 'Ada', 'Engine', 'Monday']);

    // All of it is there after a reload, and goes into the PowerPoint file with the heading merged.
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);
    await page.reload();
    await expect(thumbs(page)).toHaveCount(2, { timeout: 30_000 });
    await thumbs(page).nth(1).click();
    await expect(cells).toHaveCount(7);
    expect(await sheet(page).locator('.el-table-lines line[stroke="#e03131"]').count()).toBe(10);
    const kept = await cellSizes(page);
    expect(kept[0]!.w).toBeCloseTo(merged[0]!.w, -1);
    await page.getByTestId('slides-more').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('slides-pptx-button').click();
    const bytes = fs.readFileSync((await (await downloading).path())!);
    const { unzipSync, strFromU8 } = await import('fflate');
    const slide = strFromU8(unzipSync(new Uint8Array(bytes))['ppt/slides/slide2.xml']!);
    expect(slide).toContain('gridSpan="3"');
    expect(slide).toContain('hMerge="1"');
    expect(slide).toContain('E03131');
  });
});
