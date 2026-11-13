import { expect, test, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

/** A small picture with something in it: a 24×16 PNG of solid colour. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR42mNkYPjPQAXASK0BjBoxasSoEQMBAAD8ARHfCDc5AAAAAElFTkSuQmCC',
  'base64',
);

function loadedImages(page: Page): Promise<number> {
  return documentBody(page).locator('img').evaluateAll(
    images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length,
  );
}

/** Where the document says each picture is: its own attachment, or somewhere else. */
function pictureSources(page: Page): Promise<string[]> {
  return documentBody(page).locator('img').evaluateAll(
    images => images.map(image => (image as HTMLImageElement).dataset.attachment ? 'attachment' : (image as HTMLImageElement).getAttribute('src') ?? ''),
  );
}

async function pasteHtml(page: Page, html: string): Promise<void> {
  await page.evaluate(async (markup) => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([markup], { type: 'text/html' }),
      'text/plain': new Blob([markup.replace(/<[^>]*>/g, '')], { type: 'text/plain' }),
    })]);
  }, html);
  await page.keyboard.press('ControlOrMeta+v');
}

test.describe('copying and pasting pictures in documents', () => {
  test.setTimeout(180_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('text and a picture copied from one document paste into another with the picture kept', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Source');
    await typeInDocument(page, 'Above the picture');
    await page.keyboard.press('Enter');
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PICTURE });
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toBe(1);
    await expectSaved(page);
    // Copy it as it is after a reload, as from any document opened later.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => loadedImages(page), { timeout: 60_000 }).toBe(1);
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Target');
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(documentBody(page)).toContainText('Above the picture');
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toBe(1);
    // The picture is now the target's own, so it survives on its own.
    await expect.poll(() => pictureSources(page), { timeout: 30_000 }).toEqual(['attachment']);
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Above the picture', { timeout: 60_000 });
    await expect.poll(() => loadedImages(page), { timeout: 60_000 }).toBe(1);
  });

  test('a picture pasted with text from elsewhere is stored in the document; one that cannot be fetched is left out', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'From the web');
    await documentBody(page).click();
    const dataUrl = `data:image/png;base64,${PICTURE.toString('base64')}`;
    await pasteHtml(page, `<p>Seen on a page</p><img src="${dataUrl}" alt="square"><p>and a broken one</p><img src="http://127.0.0.1:9/missing.png">`);
    await expect(documentBody(page)).toContainText('Seen on a page');
    await expect.poll(() => pictureSources(page), { timeout: 30_000 }).toEqual(['attachment']);
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toBe(1);
    await expect(page.getByRole('alert')).toContainText('One picture could not be copied.');
    await expectSaved(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => loadedImages(page), { timeout: 60_000 }).toBe(1);
  });
});
