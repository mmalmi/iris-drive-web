import { expect, test, type Locator, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { addShapeAt, createPresentation, elements, sheet, shot } from './slides.helpers';

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
});
