import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, type Locator } from './fixtures';

/** Creates a presentation in the folder that is open and waits for its first slide. */
export async function createPresentation(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-slides').filter({ visible: true }).first().click();
  await page.getByPlaceholder('Presentation name...').fill(title);
  await page.getByPlaceholder('Presentation name...').press('Enter');
  await expect(page.getByTestId('document-title')).toHaveText(title, { timeout: 30_000 });
  await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
  await expect(thumbs(page)).toHaveCount(1);
}

export function sheet(page: Page): Locator {
  return page.getByTestId('slide-sheet');
}

export function thumbs(page: Page): Locator {
  return page.getByTestId('slide-thumb');
}

/** Elements of the slide on the canvas, optionally of one kind. */
export function elements(page: Page, type?: 'text' | 'shape' | 'line' | 'image'): Locator {
  return sheet(page).locator(type ? `[data-el][data-type="${type}"]` : '[data-el]');
}

/** A point given in slide units (the slide is 1280 × 720) as a point on the page. */
export async function slidePoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await sheet(page).boundingBox())!;
  const scale = box.width / 1280;
  return { x: box.x + x * scale, y: box.y + y * scale };
}

export async function clickSlide(page: Page, x: number, y: number, modifier?: 'Shift' | 'ControlOrMeta'): Promise<void> {
  const point = await slidePoint(page, x, y);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y);
  if (modifier) await page.keyboard.up(modifier);
}

/** Drags from one point of the slide to another, in a few steps the way a hand does. */
export async function dragSlide(page: Page, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  const start = await slidePoint(page, from[0], from[1]);
  const end = await slidePoint(page, to[0], to[1]);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps });
  await page.mouse.up();
}

/** The frame of an element as stored, read from where it is drawn. */
export async function frameOf(element: Locator): Promise<{ x: number; y: number; w: number; h: number }> {
  return element.evaluate((node) => {
    const style = (node as HTMLElement).style;
    return {
      x: Number.parseFloat(style.left),
      y: Number.parseFloat(style.top),
      w: Number.parseFloat(style.width) || Number((node as Element).getAttribute('width')),
      h: Number.parseFloat(style.height) || Number((node as Element).getAttribute('height')),
    };
  });
}

/** Types into the nth text box of the slide on the canvas. */
export async function typeInBox(page: Page, index: number, text: string): Promise<void> {
  await elements(page, 'text').nth(index).click();
  await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
  await page.keyboard.type(text);
}

/** Selects words in the text box being typed in the way a hand does: a click where they start, Shift and a click where they end. */
export async function selectWords(page: Page, words: string): Promise<void> {
  const rect = await sheet(page).locator('.ProseMirror').evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      const box = range.getBoundingClientRect();
      return { left: box.left, right: box.right, y: box.top + box.height / 2 };
    }
    throw new Error(`"${wanted}" is not in the text box`);
  }, words);
  await page.mouse.click(rect.left + 0.5, rect.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(rect.right - 0.5, rect.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(words);
  await settle(page);
}

/**
 * Waits as long as a person takes between moving the cursor and the next key.
 * The browser tells the editor where the cursor went a frame after it moved.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(200);
}

export async function expectSlidesSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
}

/** Saves a screenshot where a person can look at it afterwards. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SLIDES_SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A picture with something to see in it: coloured bands, as an SVG file. */
export function bandsSvg(width = 640, height = 400): Buffer {
  const colours = ['#0b84c6', '#2c8a5c', '#f2c94c', '#e4572e', '#7647fe'];
  const bands = colours
    .map((colour, index) => `<rect x="${(index * width) / colours.length}" y="0" width="${width / colours.length}" height="${height}" fill="${colour}"/>`)
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bands}<circle cx="${width / 2}" cy="${height / 2}" r="${height / 4}" fill="#fff"/></svg>`);
}
