import { expect, test, type Locator, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  addShapeAt,
  addTextAt,
  clickSlide,
  createPresentation,
  dragSlide,
  drawShape,
  elements,
  frameOf,
  selectWords,
  settle,
  sheet,
  shot,
  slidePoint,
  thumbs,
  typeInBox,
} from './slides.helpers';

/** How the text of a box sits in it: the size it is drawn at, and whether all of it is inside the box. */
async function fitOf(box: Locator): Promise<{ size: number; inside: boolean; fit: number }> {
  return box.evaluate((node) => {
    const text = node.querySelector('.el-text') as HTMLElement;
    const inner = node.querySelector('.el-text-inner') as HTMLElement;
    return {
      size: Number.parseFloat(getComputedStyle(text).fontSize),
      inside: inner.offsetHeight <= (node as HTMLElement).offsetHeight - 16 + 1,
      fit: Number(text.style.getPropertyValue('--fit') || 1),
    };
  });
}

async function dragHandle(page: Page, selector: string, dx: number, dy: number, hold?: 'Shift'): Promise<void> {
  const box = (await sheet(page).locator(selector).boundingBox())!;
  const scale = (await sheet(page).boundingBox())!.width / 1280;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (hold) await page.keyboard.down(hold);
  await page.mouse.move(x + dx * scale / 2, y + dy * scale / 2, { steps: 4 });
  await page.mouse.move(x + dx * scale, y + dy * scale, { steps: 4 });
  await page.mouse.up();
  if (hold) await page.keyboard.up(hold);
}

async function blankSlide(page: Page): Promise<void> {
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-blank').click();
  await expect(elements(page)).toHaveCount(0);
}

test.describe('text and shapes that behave', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('text never spills out of sight: titles and points shrink to fit, text boxes grow', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Fitting');
    await page.keyboard.press('ControlOrMeta+m');
    await expect(thumbs(page)).toHaveCount(2);
    const title = elements(page, 'text').nth(0);
    const body = elements(page, 'text').nth(1);

    // Eight short points fit as they are: a plain slide needs no fiddling with sizes.
    await page.keyboard.type('Eight points');
    await page.keyboard.press('Tab');
    for (let point = 1; point <= 8; point += 1) {
      if (point > 1) await page.keyboard.press('Enter');
      await page.keyboard.type(`Point number ${point}`);
    }
    expect(await fitOf(body)).toEqual({ size: 32, inside: true, fit: 1 });
    await shot(page, 'fit-01-eight-points');

    // More than fit: already while typing, the text gets smaller instead of running off the slide.
    for (let point = 9; point <= 14; point += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Point number ${point}`);
    }
    const crowded = await fitOf(body);
    expect(crowded.inside).toBe(true);
    expect(crowded.size).toBeLessThan(32);
    expect(crowded.size).toBeGreaterThan(16);
    await shot(page, 'fit-02-fourteen-points-typing');
    await page.keyboard.press('Escape');
    // Drawn the same once the editor is gone, and in the small slide beside it.
    expect(await fitOf(body)).toEqual(crowded);
    expect((await fitOf(thumbs(page).nth(1).locator('[data-el]').nth(1))).fit).toBe(crowded.fit);
    await expect(body.locator('li')).toHaveCount(14);
    const frame = await frameOf(body);
    expect(frame.h).toBe(464);

    // Taking points away lets the text grow back.
    await typeInBox(page, 1, '');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Just one point');
    await page.keyboard.press('Escape');
    expect(await fitOf(body)).toEqual({ size: 32, inside: true, fit: 1 });
    // Typing over everything replaced the words, not the list they were in.
    await expect(body.locator('li')).toHaveText(['Just one point']);

    // A long title wraps, then shrinks, and never leaves its box.
    await typeInBox(page, 0, ', and a title that goes on and on, well past what two lines at full size could ever hold, to see what becomes of it');
    const long = await fitOf(title);
    expect(long.inside).toBe(true);
    expect(long.size).toBeLessThan(52);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await shot(page, 'fit-03-long-title');

    // Making a box smaller shrinks its text with it, as the handle is dragged.
    await body.click();
    await page.keyboard.type(' and a second point with quite a few more words in it than the first one had');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A third');
    await page.keyboard.press('Escape');
    await dragHandle(page, '[data-handle="se"]', -700, -340);
    const squeezed = await fitOf(body);
    expect(squeezed.inside).toBe(true);
    expect(squeezed.size).toBeLessThan(32);
    await shot(page, 'fit-04-squeezed-body');
    await page.getByRole('button', { name: 'Undo' }).click();
    expect((await fitOf(body)).size).toBe(32);

    // There is a floor: text is never shrunk to less than half, the box grows instead.
    await blankSlide(page);
    await page.getByTestId('relayout-content').waitFor({ state: 'detached' });
    await page.getByTestId('slide-layout').click();
    await page.getByTestId('relayout-content').click();
    await page.keyboard.type('T');
    await page.keyboard.press('Tab');
    for (let point = 1; point <= 30; point += 1) {
      if (point > 1) await page.keyboard.press('Enter');
      await page.keyboard.type(`Line ${point}`);
    }
    await page.keyboard.press('Escape');
    const floor = elements(page, 'text').nth(1);
    expect((await fitOf(floor)).size).toBe(16);
    expect((await fitOf(floor)).inside).toBe(true);
    expect((await frameOf(floor)).h).toBeGreaterThan(464);

    // A text box of one's own grows instead: when its text is made bigger, and when it is made narrower.
    await blankSlide(page);
    await addTextAt(page, 200, 200);
    await page.keyboard.type('A text box holds as many words as are typed into it and grows downwards to make room for them');
    await page.keyboard.press('Escape');
    const free = elements(page, 'text').first();
    const typed = await frameOf(free);
    expect(typed.h).toBeGreaterThan(100);
    await page.getByTestId('font-size-input').fill('48');
    await page.getByTestId('font-size-input').press('Enter');
    await expect.poll(async () => (await frameOf(free)).h).toBeGreaterThan(typed.h + 80);
    const bigger = await frameOf(free);
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(1);
    await dragHandle(page, '[data-handle="e"]', -200, 0);
    await expect.poll(async () => (await frameOf(free)).h).toBeGreaterThan(bigger.h + 40);
    expect((await frameOf(free)).w).toBe(320);
    expect((await fitOf(free)).inside).toBe(true);
    await shot(page, 'fit-05-text-box-grown');
    // The size change and the room made for it are one step back.
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await frameOf(free)).toEqual(bigger);
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await frameOf(free)).toEqual(typed);
  });

  test('things are drawn where they are wanted, and several are resized and turned as one', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Drawing');
    await blankSlide(page);

    // A shape takes the frame that was dragged out for it; Escape puts a tool down again.
    await drawShape(page, 'rect', [100, 100], [300, 220]);
    expect(await frameOf(elements(page, 'shape').nth(0))).toEqual({ x: 100, y: 100, w: 200, h: 120 });
    await page.getByTestId('add-shape').click();
    await page.getByTestId('shape-ellipse').click();
    await expect(page.getByTestId('slide-canvas')).toHaveAttribute('data-tool', 'shape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('slide-canvas')).not.toHaveAttribute('data-tool');
    await clickSlide(page, 900, 600);
    await expect(elements(page, 'shape')).toHaveCount(1);

    // Shift makes a circle of an ellipse; a plain click drops one of the usual size there.
    await page.getByTestId('add-shape').click();
    await page.getByTestId('shape-ellipse').click();
    const from = await slidePoint(page, 400, 100);
    const to = await slidePoint(page, 520, 160);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await shot(page, 'draw-01-sketching');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    expect(await frameOf(elements(page, 'shape').nth(1))).toEqual({ x: 400, y: 100, w: 120, h: 120 });
    await addShapeAt(page, 'round', 900, 500);
    expect(await frameOf(elements(page, 'shape').nth(2))).toEqual({ x: 760, y: 415, w: 280, h: 170 });
    await page.keyboard.press('Delete');

    // A text box takes the width it was drawn with and is ready to type in.
    await page.getByTestId('add-text').click();
    await dragSlide(page, [100, 400], [420, 430]);
    await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
    await page.keyboard.type('Drawn text');
    await page.keyboard.press('Escape');
    expect(await frameOf(elements(page, 'text').first())).toEqual({ x: 100, y: 400, w: 320, h: 64 });
    // A line, drawn right to left.
    await drawShape(page, 'line', [700, 300], [560, 400]);
    await expect(elements(page, 'line')).toHaveCount(1);

    // Select the rectangle and the circle: one frame around both, with its own handles.
    await page.keyboard.press('Escape');
    await elements(page, 'shape').nth(0).click();
    await page.keyboard.down('Shift');
    await elements(page, 'shape').nth(1).click();
    await page.keyboard.up('Shift');
    const group = sheet(page).getByTestId('group-frame');
    await expect(group).toHaveCount(1);
    await shot(page, 'draw-02-group');

    // Dragging its corner out to twice the size doubles both and keeps them apart as they were.
    await dragHandle(page, '[data-group-handle="se"]', 420, 120);
    expect(await frameOf(elements(page, 'shape').nth(0))).toEqual({ x: 100, y: 100, w: 400, h: 240 });
    expect(await frameOf(elements(page, 'shape').nth(1))).toEqual({ x: 700, y: 100, w: 240, h: 240 });
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await frameOf(elements(page, 'shape').nth(1))).toEqual({ x: 400, y: 100, w: 120, h: 120 });

    // Turning the group a quarter, with Shift to land on it exactly: both turn about the middle of the group.
    await dragHandle(page, '[data-group-handle="rotate"]', 260, 86, 'Shift');
    const turned = await elements(page, 'shape').nth(0).evaluate(node => (node as HTMLElement).style.transform);
    expect(turned).toBe('rotate(90deg)');
    const rect = await frameOf(elements(page, 'shape').nth(0));
    // The rectangle sat left of the middle (310, 160); a quarter turn puts it above.
    expect(rect.x + rect.w / 2).toBeCloseTo(310, 0);
    expect(rect.y + rect.h / 2).toBeCloseTo(50, 0);
    await shot(page, 'draw-03-group-turned');
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await elements(page, 'shape').nth(0).evaluate(node => (node as HTMLElement).style.transform)).toBe('');
  });

  test('a menu on the slide, and deck shortcuts that work in the middle of typing', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Menus');

    // The list buttons show what the cursor is in: not pressed in a title or subtitle.
    await page.keyboard.type('Title');
    await page.keyboard.press('Tab');
    await page.keyboard.type('One line of subtitle');
    await settle(page);
    await expect(page.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Numbered list' })).toHaveAttribute('aria-pressed', 'false');

    // A new slide straight from the text box, without leaving it first; then on into its points.
    await page.keyboard.press('ControlOrMeta+m');
    await expect(thumbs(page)).toHaveCount(2);
    await expect(thumbs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.type('Second');
    await page.keyboard.press('Tab');
    await page.keyboard.type('A point');
    await settle(page);
    await expect(page.getByRole('button', { name: 'Bulleted list' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ControlOrMeta+m');
    await expect(thumbs(page)).toHaveCount(3);
    await thumbs(page).nth(0).click();
    await expect(sheet(page)).toContainText('One line of subtitle');
    // Page Down walks on from inside a text box too.
    await typeInBox(page, 0, '!');
    await page.keyboard.press('PageDown');
    await expect(sheet(page)).toContainText('A point');
    await expect(sheet(page).locator('.ProseMirror')).toHaveCount(0);

    // Right-click a shape: it is selected and offers what can be done with it.
    await page.keyboard.press('PageDown');
    await page.getByTestId('slide-layout').click();
    await page.getByTestId('relayout-blank').click();
    await expect(elements(page)).toHaveCount(0);
    await addShapeAt(page, 'rect', 300, 300);
    await addShapeAt(page, 'ellipse', 420, 340);
    await page.keyboard.press('Escape');
    const order = () => elements(page).evaluateAll(nodes => nodes.map(node => (node.querySelector('.el-shape') as HTMLElement).style.borderRadius));
    expect(await order()).toEqual(['0px', '50%']);
    await elements(page, 'shape').nth(0).click({ button: 'right', position: { x: 20, y: 20 } });
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(1);
    await shot(page, 'menu-01-element');
    await page.getByTestId('element-menu-front').click();
    expect(await order()).toEqual(['50%', '0px']);
    await elements(page, 'shape').nth(1).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByTestId('element-menu-duplicate').click();
    await expect(elements(page, 'shape')).toHaveCount(3);
    await elements(page, 'shape').nth(2).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByTestId('element-menu-cut').click();
    await expect(elements(page, 'shape')).toHaveCount(2);
    // On an empty part of the slide the menu pastes.
    await sheet(page).click({ button: 'right', position: { x: 600, y: 420 } });
    await expect(page.getByTestId('element-menu-cut')).toHaveCount(0);
    await page.getByTestId('element-menu-paste').click();
    await expect(elements(page, 'shape')).toHaveCount(3);
    await elements(page, 'shape').nth(2).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByTestId('element-menu-copy').click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'shape')).toHaveCount(4);
    await elements(page, 'shape').nth(3).click({ button: 'right', position: { x: 20, y: 20 } });
    await page.getByTestId('element-menu-delete').click();
    await expect(elements(page, 'shape')).toHaveCount(3);
  });

  test('a slide takes another layout and keeps its text, and paragraphs are aligned one by one', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Layouts');
    await page.keyboard.press('ControlOrMeta+m');
    await page.keyboard.type('Plans');
    await page.keyboard.press('Tab');
    await page.keyboard.type('This year');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Next year');
    await page.keyboard.press('Escape');

    // Two columns: the title and the points stay, a second column appears.
    await page.getByTestId('slide-layout').click();
    await shot(page, 'layout-01-menu');
    await page.getByTestId('relayout-columns').click();
    await expect(elements(page, 'text')).toHaveCount(3);
    await expect(elements(page, 'text').nth(0)).toHaveText('Plans');
    await expect(elements(page, 'text').nth(1).locator('li')).toHaveCount(2);
    expect((await frameOf(elements(page, 'text').nth(1))).w).toBe(528);
    await expect(elements(page, 'text').nth(2)).toHaveText('Add text');
    await shot(page, 'layout-02-columns');

    // A section slide: the points become its subtitle, the empty column goes, the colours change.
    await page.getByTestId('slide-layout').click();
    await page.getByTestId('relayout-section').click();
    await expect(elements(page, 'text')).toHaveCount(2);
    await expect(elements(page, 'text').nth(1).locator('li')).toHaveCount(2);
    await expect(sheet(page).locator('.slide-surface')).not.toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await shot(page, 'layout-03-section');
    // One step back, and again: the layout change is one change.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(elements(page, 'text')).toHaveCount(3);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(elements(page, 'text')).toHaveCount(2);
    expect((await frameOf(elements(page, 'text').nth(1))).w).toBe(1104);

    // Alignment while typing belongs to the paragraph the cursor is in.
    await page.getByTestId('slide-layout').click();
    await page.getByTestId('relayout-blank').click();
    await addTextAt(page, 200, 420);
    await page.keyboard.type('Left as it was');
    await page.keyboard.press('Enter');
    await page.keyboard.type('In the middle');
    await page.getByTestId('text-align').click();
    await page.getByRole('button', { name: 'Align centre' }).click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('At the right');
    await page.getByTestId('text-align').click();
    await page.getByRole('button', { name: 'Align right' }).click();
    await page.keyboard.press('Escape');
    const box = elements(page, 'text').last();
    const aligned = () => box.locator('p').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textAlign));
    expect(await aligned()).toEqual(['left', 'center', 'right']);
    await shot(page, 'layout-04-paragraphs');
    // With the whole box selected, one alignment for all of it.
    await page.getByTestId('text-align').click();
    await page.getByRole('button', { name: 'Align centre' }).click();
    expect(await aligned()).toEqual(['center', 'center', 'center']);
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await aligned()).toEqual(['left', 'center', 'right']);

    // Words chosen with the mouse can be made bigger without touching the rest.
    await box.click();
    await selectWords(page, 'middle');
    await page.getByRole('button', { name: 'Larger text' }).click();
    await page.keyboard.press('Escape');
    await expect(box.locator('span[style*="font-size"]')).toHaveText('middle');
  });
});
