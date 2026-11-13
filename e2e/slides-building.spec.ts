import fs from 'node:fs';
import { expect, test, type Locator, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { addShapeAt, createPresentation, elements, expectSlidesSaved, sheet, shot, thumbs } from './slides.helpers';

/** How the words in an element sit: the share they are shrunk to, and whether all of them are inside the room they have. */
async function wordsIn(element: Locator): Promise<{ fit: number; inside: boolean }> {
  return element.evaluate((node) => {
    const text = node.querySelector('.el-text') as HTMLElement;
    const inner = node.querySelector('.el-text-inner') as HTMLElement;
    const style = getComputedStyle(text);
    const room = text.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
    return { fit: Number(text.style.getPropertyValue('--fit') || 1), inside: inner.offsetHeight <= room + 1 };
  });
}

async function blankSlide(page: Page): Promise<void> {
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-blank').click();
  await expect(elements(page)).toHaveCount(0);
}

test.describe('building a talk', () => {
  test.setTimeout(240_000);

  test('words in a shape shrink to stay inside it, and the notes can be given more room', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Shapes and notes');
    await blankSlide(page);

    // A rectangle: a few words sit at their own size; many shrink, and none spill out.
    await addShapeAt(page, 'rect', 640, 360);
    const shape = elements(page, 'shape').first();
    await page.keyboard.type('Short label');
    await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
    expect(await wordsIn(shape)).toEqual({ fit: 1, inside: true });
    await page.keyboard.type(' that goes on to say a great deal more than a box of this size was ever meant to hold, line after line');
    const crowded = await wordsIn(shape);
    expect(crowded.inside).toBe(true);
    expect(crowded.fit).toBeLessThan(1);
    await page.keyboard.press('Escape');
    expect(await wordsIn(shape)).toEqual(crowded);
    await shot(page, 'build-01-shape-text');

    // An ellipse keeps its words inside the curve.
    await page.keyboard.press('Escape');
    await addShapeAt(page, 'ellipse', 300, 200);
    await page.keyboard.type('Words in a round shape stay away from its edge');
    await page.keyboard.press('Escape');
    expect((await wordsIn(elements(page, 'shape').nth(1))).inside).toBe(true);

    // The notes: dragged taller, remembered after a reload, and sized from the keyboard too.
    const pane = page.getByTestId('notes-pane');
    const before = (await pane.boundingBox())!.height;
    const divider = (await page.getByTestId('notes-divider').boundingBox())!;
    await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider.x + divider.width / 2, divider.y - 60, { steps: 4 });
    await page.mouse.move(divider.x + divider.width / 2, divider.y - 120, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await pane.boundingBox())!.height).toBeGreaterThan(before + 100);
    const taller = (await pane.boundingBox())!.height;
    await page.getByTestId('speaker-notes').fill('Point at the chart.\nThen ask for questions.');
    await shot(page, 'build-02-notes-taller');
    await page.reload();
    await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => Math.round((await pane.boundingBox())!.height)).toBe(Math.round(taller));
    await page.getByTestId('notes-divider').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await pane.boundingBox())!.height).toBeLessThan(taller - 10);
    // However far it is dragged, the slide keeps room of its own.
    await page.keyboard.press('Home');
    const canvas = (await page.getByTestId('slide-canvas').boundingBox())!;
    expect(canvas.height).toBeGreaterThan(120);
  });

  test('a table: picked by size, typed in cell by cell, reshaped, filled, and kept', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Table');
    await blankSlide(page);
    const cells = sheet(page).locator('[data-cell]');
    const cellText = () => cells.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText.trim()));

    await page.getByTestId('add-table').click();
    await page.getByTestId('table-2x3').hover();
    await expect(page.getByTestId('table-size')).toHaveText('2 × 3');
    await page.getByTestId('table-2x3').click();
    await expect(elements(page, 'table')).toHaveCount(1);
    await expect(cells).toHaveCount(6);
    // Typing starts in the first cell; Tab goes on, and past the last cell adds a row.
    await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
    for (const word of ['Team', 'Spring', 'Autumn', 'North', '12', '18']) {
      await page.keyboard.type(word);
      await page.keyboard.press('Tab');
    }
    await page.keyboard.type('South');
    await expect(cells).toHaveCount(9);
    expect(await cellText()).toEqual(['Team', 'Spring', 'Autumn', 'North', '12', '18', 'South', '', '']);

    // A column to the right of the one being typed in, and away again with undo.
    await page.getByTestId('table-lines').click();
    await page.getByTestId('table-column-right').click();
    expect(await cellText()).toEqual(['Team', '', 'Spring', 'Autumn', 'North', '', '12', '18', 'South', '', '', '']);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(cells).toHaveCount(9);

    // A click in a cell types there; that cell gets a fill of its own.
    await cells.nth(4).click();
    await expect(cells.nth(4).locator('.ProseMirror')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' and many more words than such a small cell could show at their full size');
    const crowded = await cells.nth(4).evaluate((node) => {
      const inner = node.querySelector('.el-text-inner') as HTMLElement;
      const style = getComputedStyle(node);
      const room = node.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
      return { fit: Number((node as HTMLElement).style.getPropertyValue('--fit') || 1), inside: inner.offsetHeight <= room + 1 };
    });
    expect(crowded.inside).toBe(true);
    expect(crowded.fit).toBeLessThan(1);
    await page.getByTestId('cell-fill').click();
    await page.locator('[data-colour="#f2c94c"]').click();
    await expect(cells.nth(4)).toHaveCSS('background-color', 'rgb(242, 201, 76)');
    await expect(cells.nth(5)).not.toHaveCSS('background-color', 'rgb(242, 201, 76)');
    // The row of that cell goes.
    await page.getByTestId('table-lines').click();
    await page.getByTestId('table-row-delete').click();
    expect(await cellText()).toEqual(['Team', 'Spring', 'Autumn', 'South', '', '']);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(cells).toHaveCount(9);
    await shot(page, 'build-04-table');

    // All of it is there after a reload, also in the slide beside it.
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);
    await page.reload();
    await expect(thumbs(page)).toHaveCount(2, { timeout: 30_000 });
    await thumbs(page).nth(1).click();
    await expect(cells).toHaveCount(9);
    expect((await cellText()).slice(0, 4)).toEqual(['Team', 'Spring', 'Autumn', 'North']);
    await expect(cells.nth(4)).toHaveCSS('background-color', 'rgb(242, 201, 76)');
    await expect(thumbs(page).nth(1).locator('[data-cell]')).toHaveCount(9);

    // The deck, table and all, downloads as a PowerPoint file.
    await page.getByTestId('slides-more').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('slides-pptx-button').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('Table.pptx');
    const bytes = fs.readFileSync((await download.path())!);
    if (process.env.SLIDES_SHOTS) fs.writeFileSync(`${process.env.SLIDES_SHOTS}/build-07-table.pptx`, bytes);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from('ppt/slides/slide2.xml'))).toBe(true);
  });

  test('slides come in with a transition, and points one at a time, also in the presenter\'s window', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Moving');
    await page.keyboard.type('Moving');
    await page.keyboard.press('ControlOrMeta+m');
    await page.keyboard.type('Three things');
    await page.keyboard.press('Tab');
    await page.keyboard.type('First');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Third');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // With nothing selected, Tab leaves the slide for the notes instead of keeping the keyboard there.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('notes-divider')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('slide-canvas')).toBeFocused();

    // This slide slides in and shows its points one at a time; the strip marks it.
    await page.getByTestId('slide-motion').click();
    await page.getByTestId('transition-slide').click();
    await page.getByTestId('slide-build').click();
    await expect(page.getByTestId('slide-build')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, 'build-05-motion-menu');
    await page.keyboard.press('Escape');
    await expect(thumbs(page).nth(1).getByTestId('slide-moves')).toBeVisible();
    await expect(thumbs(page).nth(0).getByTestId('slide-moves')).toHaveCount(0);
    await expectSlidesSaved(page);

    await thumbs(page).nth(0).click();
    await page.getByTestId('slides-more').click();
    const opening = context.waitForEvent('page');
    await page.getByTestId('present-with-notes').click();
    const presenter = await opening;
    const audience = page.getByTestId('present-view');
    const view = presenter.getByTestId('presenter-view');
    await expect(view).toBeVisible({ timeout: 60_000 });
    const shownPoints = () => audience.locator('li').evaluateAll(items => items.filter(item => getComputedStyle(item).visibility !== 'hidden').map(item => item.textContent));

    await page.keyboard.press('ArrowRight');
    await expect(audience).toHaveAttribute('data-slide-index', '1');
    await expect(audience).toHaveAttribute('data-step', '0');
    await expect(audience).toContainText('Three things');
    expect(await shownPoints()).toEqual([]);
    await expect(view).toHaveAttribute('data-step', '0');
    await expect(presenter.getByTestId('presenter-points')).toHaveText('Point 0 of 3');
    await page.keyboard.press('ArrowRight');
    await expect(audience).toHaveAttribute('data-step', '1');
    await expect.poll(shownPoints).toEqual(['First']);
    // The presenter's window moves the points on too, and shows what comes next.
    await presenter.keyboard.press('ArrowRight');
    await expect(audience).toHaveAttribute('data-step', '2');
    await expect.poll(shownPoints).toEqual(['First', 'Second']);
    await expect(view).toHaveAttribute('data-step', '2');
    await presenter.setViewportSize({ width: 1180, height: 720 });
    await shot(presenter, 'build-06-presenter-points');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(audience).toHaveAttribute('data-slide-index', '-1');
    // Back from the end: the slide is there complete.
    await page.keyboard.press('ArrowLeft');
    await expect(audience).toHaveAttribute('data-slide-index', '1');
    await expect.poll(shownPoints).toEqual(['First', 'Second', 'Third']);
    await page.keyboard.press('Escape');
    await expect(audience).toHaveCount(0);
    // In the editor every point shows, as always.
    await expect(elements(page, 'text').nth(1).locator('li')).toHaveCount(3);
    expect(await elements(page, 'text').nth(1).locator('li').evaluateAll(items => items.every(item => getComputedStyle(item).visibility !== 'hidden'))).toBe(true);
  });

  test('on a phone the common tools fit in one row, and simple edits are easy', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Pocket edits');
    await page.keyboard.type('Picnic');
    await page.keyboard.press('ControlOrMeta+m');
    await page.keyboard.type('Bring');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Bread');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Cheese');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+m');
    await page.keyboard.type('Where');
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);

    const context = await browser.newContext({
      viewport: { width: 375, height: 740 },
      hasTouch: true,
      isMobile: true,
      storageState: await page.context().storageState({ indexedDB: true }),
    });
    try {
      const phone = await context.newPage();
      await phone.goto(page.url());
      await expect(thumbs(phone)).toHaveCount(3, { timeout: 60_000 });
      const toolbar = phone.getByTestId('slides-toolbar');
      const fitsAcross = () => toolbar.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
      expect(await fitsAcross()).toBe(true);

      // A new title, typed over the old one; Bold is at hand while typing, and everything still fits.
      await thumbs(phone).nth(0).tap();
      await elements(phone, 'text').nth(0).tap();
      await expect(sheet(phone).locator('.ProseMirror')).toBeFocused();
      await phone.keyboard.press('ControlOrMeta+a');
      await phone.keyboard.type('Summer picnic');
      await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeVisible();
      expect(await fitsAcross()).toBe(true);
      await phone.keyboard.press('Escape');
      await expect(thumbs(phone).nth(0)).toContainText('Summer picnic');

      // One more point on the list.
      await thumbs(phone).nth(1).tap();
      await elements(phone, 'text').nth(1).tap();
      await expect(sheet(phone).locator('.ProseMirror')).toBeFocused();
      await phone.keyboard.press('ControlOrMeta+End');
      await phone.keyboard.press('Enter');
      await phone.keyboard.type('Lemonade');
      await phone.keyboard.press('Escape');
      await expect(elements(phone, 'text').nth(1).locator('li')).toHaveText(['Bread', 'Cheese', 'Lemonade']);

      // The rest is in a sheet: here, another layout for the slide.
      await phone.getByTestId('toolbar-more').tap();
      await expect(phone.getByTestId('toolbar-sheet')).toBeVisible();
      await shot(phone, 'build-03-phone-sheet');
      await phone.getByTestId('slide-layout').tap();
      await phone.getByTestId('relayout-columns').tap();
      await expect(elements(phone, 'text')).toHaveCount(3);
      await expect(phone.getByTestId('toolbar-sheet')).toHaveCount(0);

      // Reordered from the slide's menu, then presented.
      await thumbs(phone).nth(2).tap();
      await thumbs(phone).nth(2).getByRole('button', { name: 'Slide options' }).tap();
      await phone.getByTestId('slide-menu-earlier').tap();
      const titles = () => thumbs(phone).evaluateAll(nodes => nodes.map(node => node.querySelector('[data-el]')?.textContent?.trim()));
      expect(await titles()).toEqual(['Summer picnic', 'Where', 'Bring']);
      await phone.getByTestId('present').tap();
      await expect(phone.getByTestId('present-view')).toHaveAttribute('data-slide-index', '1');
      await phone.getByTestId('present-exit').tap();
      await expect(phone.getByTestId('present-view')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
