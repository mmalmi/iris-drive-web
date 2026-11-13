import { expect, test, type Page } from './fixtures';
import { createDocument, createDriveProfile, documentBody, expectSaved, prepareFreshSession, typeInDocument } from './documents.helpers';
import { bandsSvg, clickSlide, createPresentation, elements, sheet } from './slides.helpers';
import { createSpreadsheet, goTo } from './sheets.helpers';

/** A 24 × 16 PNG of solid colour. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR42mNkYPjPQAXASK0BjBoxasSoEQMBAAD8ARHfCDc5AAAAAElFTkSuQmCC',
  'base64',
);

interface Held {
  types: string[];
  width: number;
  height: number;
  html: string;
}

/** What the system clipboard holds, read back as another app would: its kinds, the PNG picture's size and the HTML. */
async function clipboard(page: Page): Promise<Held | null> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const types = items.flatMap(item => [...item.types]);
    const picture = items.find(item => item.types.includes('image/png'));
    const bitmap = picture ? await createImageBitmap(await picture.getType('image/png')) : null;
    const htmlItem = items.find(item => item.types.includes('text/html'));
    const html = htmlItem ? await (await htmlItem.getType('text/html')).text() : '';
    return { types, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0, html };
  }).catch(() => null);
}

async function clearClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(''));
}

function loadedImages(page: Page): Promise<number[]> {
  return documentBody(page).locator('img').evaluateAll(images => images.map(image => (image as HTMLImageElement).naturalWidth));
}

function storedPictures(page: Page): Promise<boolean[]> {
  return documentBody(page).locator('img').evaluateAll(images => images.map(image => !!(image as HTMLImageElement).dataset.attachment));
}

test.describe('pictures copied out of the editors reach other apps as pictures', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a document copies its pictures as image data, and they paste back in as its own', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Pictures out');
    await typeInDocument(page, 'Above the picture');
    await page.keyboard.press('Enter');
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PICTURE });
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toEqual([24]);
    await expectSaved(page);

    // Words and the picture: the HTML carries the picture inline, and the picture goes as PNG too.
    await clearClipboard(page);
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ width: 24, height: 16 });
    const both = (await clipboard(page))!;
    expect(both.types).toEqual(expect.arrayContaining(['text/html', 'text/plain', 'image/png']));
    expect(both.html).toContain('Above the picture');
    expect(both.html).toMatch(/src="data:image\/png;base64,/);
    expect(both.html).not.toContain('/htree/');

    // The picture alone.
    await clearClipboard(page);
    await documentBody(page).locator('img').click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ width: 24, height: 16 });

    // Pasted into another document, the words and the picture arrive, and the picture is stored there.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(async () => (await clipboard(page))?.html ?? '', { timeout: 15_000 }).toContain('Above the picture');
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Pasted back');
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(documentBody(page)).toContainText('Above the picture');
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toEqual([24]);
    await expect.poll(() => storedPictures(page), { timeout: 30_000 }).toEqual([true]);
    await page.screenshot({ path: test.info().outputPath('clipboard-document-pasted-back.png') });
    await expectSaved(page);
  });

  test('a picture file copied from the Drive pastes into a document; a file that is not a picture is turned away', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await page.getByTestId('folder-toolbar').first().locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PICTURE });
    await expect(page.getByTestId('image-viewer')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('ControlOrMeta+c');
    await expect(page.getByText('Copied the picture square.png')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('viewer-back').click();

    await createDocument(page, 'From the Drive');
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toEqual([24]);
    await expect.poll(() => storedPictures(page), { timeout: 30_000 }).toEqual([true]);

    await documentBody(page).evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }));
      const box = element.querySelector('p')!.getBoundingClientRect();
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 4, clientY: box.top + box.height / 2 }));
    });
    await expect(page.getByText('Only pictures can be dropped into a document.')).toBeVisible();
    expect(page.url()).toContain('From%20the%20Drive');
  });

  test('pictures dropped into a document and a spreadsheet are kept there, from a file or from a web page', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Dropped');
    await typeInDocument(page, 'Line');
    const base64 = PICTURE.toString('base64');
    const dropInto = (html: string | null) => documentBody(page).evaluate((element, { base64, html }) => {
      const data = new DataTransfer();
      if (html) data.setData('text/html', html);
      else data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'square.png', { type: 'image/png' }));
      const box = element.querySelector('p')!.getBoundingClientRect();
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.right - 2, clientY: box.top + box.height / 2 }));
    }, { base64, html });
    await dropInto(null);
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toEqual([24]);
    // A picture dragged from a web page comes as its address in HTML; it is fetched and stored.
    await dropInto(`<img src="data:image/png;base64,${base64}" alt="from a page">`);
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toEqual([24, 24]);
    await expect.poll(() => storedPictures(page), { timeout: 30_000 }).toEqual([true, true]);
    await expectSaved(page);

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createSpreadsheet(page, 'Dropped sheet');
    await page.getByTestId('document-editor').evaluate((element, base64) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'square.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, base64);
    await expect(page.getByTestId('sheet-picture')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sheet-picture').locator('img')).toHaveJSProperty('naturalWidth', 24);
  });

  test('a presentation copies a picture at its own size, and a whole slide, as image data', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Deck');
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-blank').click();
    await page.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(640, 400) });
    await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });

    // Right click, Copy image: the picture itself.
    await clearClipboard(page);
    await elements(page, 'image').click();
    await elements(page, 'image').click({ button: 'right' });
    await page.getByTestId('element-menu-copy-image').click();
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ types: ['image/png'], width: 640, height: 400 });

    // The keys copy it with its own size too, beside what pastes into another deck.
    await clearClipboard(page);
    await elements(page, 'image').click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ width: 640, height: 400 });

    // Nothing selected: the whole slide.
    await clearClipboard(page);
    await clickSlide(page, 30, 30);
    await sheet(page).click({ button: 'right', position: { x: 10, y: 10 } });
    await expect(page.getByTestId('element-menu-copy-image')).toHaveText('Copy slide as image');
    await page.getByTestId('element-menu-copy-image').click();
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ types: ['image/png'], width: 1920, height: 1080 });
  });

  test('a spreadsheet copies a floating picture as image data from its menu', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Sheet');
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 80;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#e8590c';
      context.fillRect(0, 0, 120, 80);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(png => resolve(png!), 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    });
    await goTo(page, 'B3');
    await page.keyboard.press('ControlOrMeta+v');
    const picture = page.getByTestId('sheet-picture');
    await expect(picture).toBeVisible({ timeout: 30_000 });
    await expect(picture.locator('img')).toHaveJSProperty('complete', true);

    await clearClipboard(page);
    await picture.click({ button: 'right' });
    await page.getByTestId('object-copy-image').click();
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ types: ['image/png'], width: 120, height: 80 });

    await clearClipboard(page);
    await picture.click();
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboard(page), { timeout: 15_000 }).toMatchObject({ width: 120, height: 80 });
  });
});
