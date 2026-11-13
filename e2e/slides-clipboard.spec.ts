import { expect, test, type Page } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { addShapeAt, bandsSvg, clickSlide, createPresentation, elements, expectSlidesSaved, sheet, shot, thumbs } from './slides.helpers';

async function blankSlide(page: Page): Promise<void> {
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-blank').click();
  await expect(elements(page)).toHaveCount(0);
}

/** Whether every picture on the slide has been drawn from its bytes. */
async function picturesLoaded(page: Page): Promise<number[]> {
  return elements(page, 'image').locator('img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).naturalWidth));
}

/** What the clipboard holds: its kinds, and the HTML when there is some. */
async function clipboardKinds(page: Page): Promise<{ types: string[]; html: string }> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const types = items.flatMap(item => item.types);
    const htmlItem = items.find(item => item.types.includes('text/html'));
    const html = htmlItem ? await (await htmlItem.getType('text/html')).text() : '';
    return { types, html };
  });
}

test.describe('copy and paste with pictures', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a picture copied in one deck pastes into another deck open in another tab, stored there, and outlives a reload', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Source deck');
    const sourceUrl = page.url();
    await blankSlide(page);
    await page.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(640, 400) });
    await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => picturesLoaded(page), { timeout: 30_000 }).toEqual([expect.any(Number)]);
    await addShapeAt(page, 'ellipse', 1100, 600);
    await expectSlidesSaved(page);

    // A second deck, in a second tab.
    await page.goto(sourceUrl.replace(/\/[^/]+$/, ''));
    await createPresentation(page, 'Target deck');
    await blankSlide(page);
    await expectSlidesSaved(page);
    const target = page;
    const source = await context.newPage();
    await source.goto(sourceUrl);
    await expect(thumbs(source)).toHaveCount(2, { timeout: 30_000 });
    await thumbs(source).nth(1).click();
    await expect.poll(() => picturesLoaded(source), { timeout: 30_000 }).not.toContain(0);
    const sourceFile = await source.evaluate(() => new URL(document.querySelector<HTMLImageElement>('[data-testid="slide-sheet"] [data-type="image"] img')!.src).pathname.split('/').pop());
    expect(sourceFile).toMatch(/\.svg$/);

    // Both the picture and the shape are copied there.
    await sheet(source).click({ position: { x: 4, y: 4 } });
    await source.keyboard.press('ControlOrMeta+a');
    await source.keyboard.press('ControlOrMeta+c');
    // The clipboard also holds a picture of them, for other apps.
    await expect.poll(async () => (await clipboardKinds(source)).types, { timeout: 15_000 }).toContain('image/png');
    const held = await clipboardKinds(source);
    expect(held.types).toContain('text/html');
    expect(held.html).toContain('data-iris-slides');
    await shot(source, 'clip-01-copied');

    // The source tab is closed before pasting: a second tab of the same account working in the same Drive can hide what
    // this one saves until it is reloaded, which has nothing to do with the clipboard.
    await source.close();
    await target.bringToFront();
    await sheet(target).click({ position: { x: 4, y: 4 } });
    await target.keyboard.press('ControlOrMeta+v');
    await expect(elements(target, 'image')).toHaveCount(1, { timeout: 30_000 });
    await expect(elements(target, 'shape')).toHaveCount(1);
    await expect.poll(() => picturesLoaded(target), { timeout: 30_000 }).not.toContain(0);
    await shot(target, 'clip-02-pasted-in-other-deck');

    // After a reload the picture is still there: it is the target deck's own file now.
    await expectSlidesSaved(target);
    await target.reload();
    await expect(thumbs(target)).toHaveCount(2, { timeout: 30_000 });
    await thumbs(target).nth(1).click();
    await expect(elements(target, 'image')).toHaveCount(1);
    await expect.poll(() => picturesLoaded(target), { timeout: 30_000 }).not.toContain(0);
    // Pictures are files beside each deck: the pasted one has a name of its own in the target deck.
    const fileName = (where: Page) => where.evaluate(() => new URL(document.querySelector<HTMLImageElement>('[data-testid="slide-sheet"] [data-type="image"] img')!.src).pathname.split('/').pop());
    expect(await fileName(target)).not.toBe(sourceFile);
  });

  test('a screenshot and a web page with words and a picture paste in; a copied slide goes out as a picture', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Pasting in');
    await blankSlide(page);

    // A screenshot on the clipboard, as an app puts it there.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 250;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#0b84c6';
      context.fillRect(0, 0, 400, 250);
      context.fillStyle = '#fff';
      context.fillRect(40, 40, 120, 60);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(result => resolve(result!), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    await sheet(page).click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });

    // Part of a web page: its words become a text box and its picture an image.
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 120;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#2c8a5c';
      context.fillRect(0, 0, 200, 120);
      const html = `<h2>Field notes</h2><p>Seen on the walk</p><img src="${canvas.toDataURL('image/png')}">`;
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob(['Field notes\nSeen on the walk'], { type: 'text/plain' }),
      })]);
    });
    await clickSlide(page, 1200, 40);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'image')).toHaveCount(2, { timeout: 30_000 });
    await expect(elements(page, 'text')).toHaveCount(1);
    await expect(elements(page, 'text')).toContainText('Field notes');
    await expect(elements(page, 'text')).toContainText('Seen on the walk');
    await expect.poll(() => picturesLoaded(page), { timeout: 30_000 }).not.toContain(0);
    await shot(page, 'clip-03-pasted-from-outside');

    // A slide copied from the strip goes onto the clipboard as a picture and as words.
    await thumbs(page).nth(1).click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(async () => (await clipboardKinds(page)).types, { timeout: 15_000 }).toContain('image/png');
    const picture = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find(each => each.types.includes('image/png'))!;
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const text = await (await (await navigator.clipboard.read())[0]!.getType('text/plain')).text();
      return { width: bitmap.width, height: bitmap.height, text };
    });
    expect(picture.width / picture.height).toBeCloseTo(16 / 9, 1);
    expect(picture.text).toContain('Field notes');
    // Pasted back in the strip, the slide comes with both pictures.
    await page.keyboard.press('ControlOrMeta+v');
    await expect(thumbs(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(elements(page, 'image')).toHaveCount(2);
  });

  test('someone who may only look can copy a slide out, and cannot paste', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Read only copy');
    await page.keyboard.type('Words to take away');
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);
    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(`${new URL(guest.url()).origin}/#${sharedUrl.split('#')[1]}`);
      await expect(thumbs(guest)).toHaveCount(1, { timeout: 60_000 });
      await thumbs(guest).first().click();
      await guest.keyboard.press('ControlOrMeta+c');
      await expect.poll(async () => (await clipboardKinds(guest)).types, { timeout: 15_000 }).toContain('image/png');
      expect(await guest.evaluate(() => navigator.clipboard.readText())).toContain('Words to take away');
      // Pasting does nothing here.
      await guest.keyboard.press('ControlOrMeta+v');
      await guest.waitForTimeout(500);
      await expect(thumbs(guest)).toHaveCount(1);
    } finally {
      await guestContext.close();
    }
  });
});
