import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  clickSlide,
  createPresentation,
  dragSlide,
  elements,
  frameOf,
  settle,
  sheet,
  shot,
  slidePoint,
  thumbs,
  typeInBox,
} from './slides.helpers';

async function blankSlide(page: Page): Promise<void> {
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-blank').click();
  await expect(elements(page)).toHaveCount(0);
}

async function addShape(page: Page, kind: 'rect' | 'round' | 'ellipse' | 'line' | 'arrow'): Promise<void> {
  await page.getByTestId('add-shape').click();
  await page.getByTestId(`shape-${kind}`).click();
}

/** Drags one of the handles of the selected element by a distance given in slide units. */
async function dragHandle(page: Page, handle: string, dx: number, dy: number, hold?: 'Shift' | 'Alt'): Promise<void> {
  const box = (await sheet(page).locator(`[data-handle="${handle}"]`).boundingBox())!;
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

const undo = (page: Page) => page.getByRole('button', { name: 'Undo' }).click();
const redo = (page: Page) => page.getByRole('button', { name: 'Redo' }).click();

test.describe('working on a slide', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('shapes can be moved, resized, turned, stacked, copied and undone', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Shapes');
    await blankSlide(page);

    await addShape(page, 'rect');
    const rect = elements(page, 'shape').first();
    const start = await frameOf(rect);
    expect(start).toEqual({ x: 500, y: 275, w: 280, h: 170 });

    // Move: one drag is one step of undo.
    await dragSlide(page, [640, 360], [300, 200]);
    const moved = await frameOf(rect);
    expect(moved.x).toBeLessThan(200);
    expect(moved.y).toBeLessThan(140);
    await undo(page);
    expect(await frameOf(rect)).toEqual(start);
    await redo(page);
    expect(await frameOf(rect)).toEqual(moved);

    // Resize from the bottom-right corner; the top-left corner stays.
    await rect.click();
    await dragHandle(page, 'se', 120, 60);
    const resized = await frameOf(rect);
    expect(resized.x).toBe(moved.x);
    expect(resized.y).toBe(moved.y);
    expect(Math.round(resized.w)).toBe(400);
    expect(Math.round(resized.h)).toBe(230);

    // Turn it with Shift held: it lands on a multiple of 15 degrees.
    await dragHandle(page, 'rotate', 200, 90, 'Shift');
    const turned = await rect.evaluate(node => (node as HTMLElement).style.transform);
    const degrees = Number(/rotate\(([-\d.]+)deg\)/.exec(turned)?.[1]);
    expect(degrees).toBeGreaterThan(0);
    expect(degrees % 15).toBe(0);
    await shot(page, 'edit-01-turned');
    await undo(page);
    expect(await rect.evaluate(node => (node as HTMLElement).style.transform)).toBe('');

    // Arrow keys nudge; a run of nudges undoes as one step.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const nudged = await frameOf(rect);
    expect(nudged.x).toBe(resized.x + 2);
    expect(nudged.y).toBe(resized.y + 10);
    await undo(page);
    expect(await frameOf(rect)).toEqual(resized);

    // A second shape, on top; then sent behind the first.
    await addShape(page, 'ellipse');
    await expect(elements(page, 'shape')).toHaveCount(2);
    await page.getByTestId('shape-fill').click();
    await page.locator('[data-colour="#f08c00"]').click();
    const order = () => elements(page).evaluateAll(nodes => nodes.map(node => (node.querySelector('.el-shape') as HTMLElement).style.borderRadius));
    expect(await order()).toEqual(['0px', '50%']);
    await page.getByTestId('arrange').click();
    await page.getByTestId('arrange-back').click();
    expect(await order()).toEqual(['50%', '0px']);
    await page.keyboard.press('ControlOrMeta+]');
    expect(await order()).toEqual(['0px', '50%']);

    // Duplicate with the keyboard, then copy and paste: each copy steps aside.
    await page.keyboard.press('ControlOrMeta+d');
    await expect(elements(page, 'shape')).toHaveCount(3);
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'shape')).toHaveCount(4);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'shape')).toHaveCount(5);
    const copies = await Promise.all([2, 3, 4].map(index => frameOf(elements(page, 'shape').nth(index))));
    expect(new Set(copies.map(copy => copy.x)).size).toBe(3);

    // Select everything by dragging a box around it, and delete.
    await clickSlide(page, 1240, 690);
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(0);
    await dragSlide(page, [1270, 710], [10, 10]);
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(5);
    await shot(page, 'edit-02-all-selected');
    await page.keyboard.press('Backspace');
    await expect(elements(page)).toHaveCount(0);
    await undo(page);
    await expect(elements(page)).toHaveCount(5);

    // Shift-click adds to and takes from the selection.
    await page.keyboard.press('Escape');
    await rect.click();
    await page.keyboard.down('Shift');
    await elements(page, 'shape').nth(1).click({ position: { x: 5, y: 60 } });
    await page.keyboard.up('Shift');
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(2);
    // Cut takes them off the slide; paste on another slide puts them there.
    await page.keyboard.press('ControlOrMeta+x');
    await expect(elements(page)).toHaveCount(3);
    await thumbs(page).first().click();
    await sheet(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'shape')).toHaveCount(2);
    await shot(page, 'edit-03-pasted-on-title');
  });

  test('text can be sized, coloured, aligned and listed, in a box or for chosen words', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Text');
    await blankSlide(page);

    // A new text box is ready to type in, and grows to hold what was typed.
    await page.getByTestId('add-text').click();
    const editor = sheet(page).locator('.ProseMirror');
    await expect(editor).toBeFocused();
    await page.keyboard.type('First line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Third line');
    await page.keyboard.press('Escape');
    const box = elements(page, 'text').first();
    await expect(box.locator('p')).toHaveCount(3);
    expect((await frameOf(box)).h).toBe(113);

    // With the box selected, size and colour apply to all of it.
    const size = page.getByTestId('font-size-input');
    await expect(size).toHaveValue('24');
    await page.getByRole('button', { name: 'Larger text' }).click();
    await expect(size).toHaveValue('28');
    await size.fill('44');
    await size.press('Enter');
    await expect(box.locator('.el-text')).toHaveCSS('font-size', '44px');
    await page.getByTestId('text-colour').click();
    await page.locator('[data-colour="#1c7ed6"]').click();
    await expect(box.locator('.el-text')).toHaveCSS('color', 'rgb(28, 126, 214)');
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(box.locator('strong')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(box.locator('strong')).toHaveCount(0);

    // Alignment.
    await page.getByTestId('text-align').click();
    await page.getByRole('button', { name: 'Align centre' }).click();
    await expect(box.locator('.el-text')).toHaveCSS('text-align', 'center');

    // Turning the selected box into a list makes every line an item.
    await page.getByRole('button', { name: 'Numbered list' }).click();
    await expect(editor.locator('ol > li')).toHaveCount(3);
    // Tab indents an item under the one before it.
    await page.keyboard.press('ArrowRight');
    await settle(page);
    await page.keyboard.press('Tab');
    await expect(editor.locator('ol ol > li')).toHaveCount(1);
    await page.keyboard.press('Shift+Tab');
    await expect(editor.locator('ol ol > li')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(box.locator('ol > li')).toHaveCount(3);
    await shot(page, 'edit-04-text-box');

    // Undo walks back through the changes without leaving the slide.
    for (let step = 0; step < 4; step += 1) await page.getByRole('button', { name: 'Undo' }).click();
    await expect(box.locator('ol')).toHaveCount(0);
    for (let step = 0; step < 4; step += 1) await page.getByRole('button', { name: 'Redo' }).click();
    await expect(box.locator('ol > li')).toHaveCount(3);

    // An emptied text box does not linger.
    await page.getByTestId('add-text').click();
    await expect(editor).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(elements(page, 'text')).toHaveCount(1);

    // Pasting plain text makes a text box of it.
    await page.evaluate(() => navigator.clipboard.writeText('Pasted from elsewhere'));
    await sheet(page).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'text')).toHaveCount(2);
    await expect(elements(page, 'text').nth(1)).toContainText('Pasted from elsewhere');
  });

  test('slides can be added, copied, reordered and removed from the strip', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Order');
    await typeInBox(page, 0, 'One');
    await page.keyboard.press('Escape');
    for (const title of ['Two', 'Three', 'Four']) {
      await page.getByTestId('new-slide').click();
      await typeInBox(page, 0, title);
      await page.keyboard.press('Escape');
    }
    const titles = () => thumbs(page).evaluateAll(nodes => nodes.map(node => node.querySelector('[data-el]')?.textContent?.trim()));
    expect(await titles()).toEqual(['One', 'Two', 'Three', 'Four']);

    // Drag the last slide to the top.
    const last = (await thumbs(page).nth(3).boundingBox())!;
    const first = (await thumbs(page).nth(0).boundingBox())!;
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2, last.y - 40, { steps: 5 });
    await page.mouse.move(first.x + first.width / 2, first.y + 6, { steps: 8 });
    await shot(page, 'edit-05-dragging-slide');
    await page.mouse.up();
    expect(await titles()).toEqual(['Four', 'One', 'Two', 'Three']);
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await titles()).toEqual(['One', 'Two', 'Three', 'Four']);

    // Keys in the strip: arrows walk, Alt+arrow moves the slide, Delete removes it.
    await thumbs(page).nth(1).click();
    await expect(sheet(page)).toContainText('Two');
    await page.keyboard.press('ArrowDown');
    await expect(sheet(page)).toContainText('Three');
    await page.keyboard.press('Alt+ArrowUp');
    expect(await titles()).toEqual(['One', 'Three', 'Two', 'Four']);
    await page.keyboard.press('ControlOrMeta+d');
    expect(await titles()).toEqual(['One', 'Three', 'Three', 'Two', 'Four']);
    await page.keyboard.press('Delete');
    expect(await titles()).toEqual(['One', 'Three', 'Two', 'Four']);

    // The menu on a slide.
    await thumbs(page).nth(3).click({ button: 'right' });
    await page.getByTestId('slide-menu-earlier').click();
    expect(await titles()).toEqual(['One', 'Three', 'Four', 'Two']);
    await thumbs(page).nth(0).click({ button: 'right' });
    await shot(page, 'edit-06-slide-menu');
    await page.getByTestId('slide-menu-delete').click();
    expect(await titles()).toEqual(['Three', 'Four', 'Two']);

    // Shift-click picks a run of slides; they move and go together.
    await thumbs(page).nth(0).click();
    await page.keyboard.down('Shift');
    await thumbs(page).nth(1).click();
    await page.keyboard.up('Shift');
    await page.keyboard.press('Alt+ArrowDown');
    expect(await titles()).toEqual(['Two', 'Three', 'Four']);
    await page.keyboard.press('Delete');
    expect(await titles()).toEqual(['Two']);
    await page.getByRole('button', { name: 'Undo' }).click();
    expect(await titles()).toEqual(['Two', 'Three', 'Four']);
  });

  test('themes and backgrounds restyle the deck', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Looks');
    await typeInBox(page, 0, 'Looks');
    await page.keyboard.press('Escape');
    await page.getByTestId('new-slide').click();
    await typeInBox(page, 0, 'Plain slide');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'With a point');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const surface = sheet(page).locator('.slide-surface');
    await expect(surface).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    for (const theme of ['dark', 'paper', 'ocean', 'forest', 'sunset']) {
      await page.getByTestId('deck-theme').click();
      if (theme === 'dark') await shot(page, 'edit-07-theme-menu');
      await page.getByTestId(`theme-${theme}`).click();
      await shot(page, `edit-08-theme-${theme}`);
      await thumbs(page).first().click();
      await shot(page, `edit-08-theme-${theme}-cover`);
      await thumbs(page).nth(1).click();
    }
    await page.getByTestId('deck-theme').click();
    await page.getByTestId('theme-dark').click();
    await expect(surface).toHaveCSS('background-color', 'rgb(19, 20, 24)');
    await expect(elements(page, 'text').first().locator('.el-text')).toHaveCSS('color', 'rgb(244, 244, 246)');

    // One slide gets its own background; the theme's comes back when asked.
    await page.getByTestId('slide-background').click();
    await page.locator('[data-colour="#0ca678"]').click();
    await expect(surface).toHaveCSS('background-color', 'rgb(12, 166, 120)');
    await thumbs(page).first().click();
    await expect(surface).not.toHaveCSS('background-color', 'rgb(12, 166, 120)');
    await thumbs(page).nth(1).click();
    await page.getByTestId('slide-background').click();
    await page.getByTestId('colour-theme').click();
    await expect(surface).toHaveCSS('background-color', 'rgb(19, 20, 24)');
    const point = await slidePoint(page, 640, 600);
    await page.mouse.move(point.x, point.y);
  });
});
