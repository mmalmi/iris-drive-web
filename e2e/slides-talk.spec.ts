import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  bandsSvg,
  clickSlide,
  createPresentation,
  dragSlide,
  drawShape,
  elements,
  expectSlidesSaved,
  frameOf,
  selectWords,
  sheet,
  shot,
  thumbs,
  typeInBox,
} from './slides.helpers';

/**
 * Someone makes a short talk from nothing, the way a person would: a title,
 * a slide of points, a picture, a diagram, a closing slide; then tidies it
 * and presents it.
 */
test.describe('making and giving a talk', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a five-slide talk, from an empty deck to the last slide on screen', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Marsh survey');

    // 1. Title slide.
    await typeInBox(page, 0, 'Marsh survey 2026');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'Counts, a map, and what we do next');
    await page.keyboard.press('Escape');

    // 2. Points, with one word made bold and one coloured.
    await page.getByTestId('new-slide').click();
    await typeInBox(page, 0, 'What we counted');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'Herons: 14 pairs');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Kites: 3, all in the north reeds');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Otters seen twice');
    const body = sheet(page).locator('.ProseMirror');
    await selectWords(page, 'Herons');
    await page.keyboard.press('ControlOrMeta+b');
    await expect(body.locator('strong')).toHaveText('Herons');
    await selectWords(page, 'Otters');
    await page.getByTestId('text-colour').click();
    await page.locator('[data-colour="#e03131"]').click();
    await expect(body.locator('span[data-colour="#e03131"]')).toHaveText('Otters');
    await page.keyboard.press('Escape');
    // Drawn the same once the editor is gone.
    await expect(elements(page, 'text').nth(1).locator('strong')).toHaveText('Herons');
    await expect(elements(page, 'text').nth(1).locator('li')).toHaveCount(3);
    await page.getByTestId('speaker-notes').fill('Mention the cold spring.');
    await shot(page, 'talk-02-points');

    // 3. Two columns: words on the left, a picture on the right.
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-columns').click();
    await expect(thumbs(page)).toHaveCount(3);
    await typeInBox(page, 0, 'Where they nest');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'The north reeds hold most nests');
    await page.keyboard.press('Escape');
    // The second column makes way for the picture.
    await typeInBox(page, 2, '');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Delete');
    await expect(elements(page, 'text')).toHaveCount(2);
    await page.getByTestId('slides-image-input').setInputFiles({ name: 'map.svg', mimeType: 'image/svg+xml', buffer: bandsSvg() });
    const image = elements(page, 'image');
    await expect(image).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => image.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // Drag it into the right-hand column; it snaps to the column's top.
    const placed = await frameOf(image);
    await dragSlide(page, [placed.x + placed.w / 2, placed.y + placed.h / 2], [930, 400]);
    const moved = await frameOf(image);
    expect(moved.x).toBeGreaterThan(600);
    await shot(page, 'talk-03-picture');

    // 4. A diagram: three boxes joined by arrows.
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-blank').click();
    await expect(elements(page)).toHaveCount(0);
    for (const [index, label] of ['Count', 'Map', 'Protect'].entries()) {
      // Each box is drawn where it belongs, by eye; the second and third settle level with the first.
      const left = 110 + index * 400;
      const top = 280 + [0, 4, -3][index]!;
      await drawShape(page, 'round', [left, top], [left + 260, top + 150 + [0, -4, 3][index]!]);
      const shape = elements(page, 'shape').nth(index);
      await expect(shape).toBeVisible();
      // Typing with a shape selected writes its label.
      await page.keyboard.type(label);
      await page.keyboard.press('Escape');
      await expect(shape).toContainText(label);
    }
    const shapes = elements(page, 'shape');
    const frames = await Promise.all([0, 1, 2].map(index => frameOf(shapes.nth(index))));
    expect(new Set(frames.map(frame => frame.y)).size).toBe(1);
    expect(new Set(frames.map(frame => frame.h)).size).toBe(1);
    for (const index of [0, 1]) {
      // An arrow is drawn from one box to the next.
      const from = frames[index]!;
      const to = frames[index + 1]!;
      const middle = from.y + from.h / 2;
      await drawShape(page, 'arrow', [from.x + from.w + 14, middle], [to.x - 14, middle - 4]);
      await expect(elements(page, 'line')).toHaveCount(index + 1);
      // Drawn nearly level, it is level.
      const line = await frameOf(elements(page, 'line').nth(index));
      expect(line).toMatchObject({ y: middle, h: 1 });
    }
    // Recolour the last box.
    await shapes.nth(2).click();
    await page.getByTestId('shape-fill').click();
    await page.locator('[data-colour="#2f9e44"]').click();
    await clickSlide(page, 640, 650);
    await shot(page, 'talk-04-diagram');

    // 5. Closing slide.
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-section').click();
    await typeInBox(page, 0, 'Thank you');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'Questions?');
    await page.keyboard.press('Escape');
    await expect(thumbs(page)).toHaveCount(5);
    await clickSlide(page, 640, 690);
    await shot(page, 'talk-05-closing');

    // Present from the second slide.
    await thumbs(page).nth(1).click();
    await expect(sheet(page)).toContainText('What we counted');
    await expectSlidesSaved(page);
    await page.getByTestId('present').click();
    const present = page.getByTestId('present-view');
    await expect(present).toBeVisible();
    await expect(present).toHaveAttribute('data-slide-index', '1');
    await expect(present).toContainText('Herons: 14 pairs');
    await shot(page, 'talk-06-presenting');
    await page.keyboard.press('ArrowRight');
    await expect(present).toHaveAttribute('data-slide-index', '2');
    await shot(page, 'talk-07-presenting-picture');
    await page.keyboard.press('Space');
    await expect(present).toHaveAttribute('data-slide-index', '3');
    await shot(page, 'talk-08-presenting-diagram');
    await page.mouse.click(600, 300);
    await expect(present).toHaveAttribute('data-slide-index', '4');
    await page.keyboard.press('ArrowLeft');
    await expect(present).toHaveAttribute('data-slide-index', '3');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('present-end')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(present).toHaveAttribute('data-slide-index', '4');
    await page.keyboard.press('Escape');
    await expect(present).toHaveCount(0);
    // Back in the editor, on the slide that was showing.
    await expect(sheet(page)).toContainText('Thank you');
    await shot(page, 'talk-09-back-in-editor');
  });
});
