import fs from 'node:fs';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { addShapeAt, bandsSvg, createPresentation, elements, expectSlidesSaved, sheet, shot, thumbs, typeInBox } from './slides.helpers';
import { inheritedPptx } from './slides.pptxSample';

/** The deck as a PowerPoint file, as the More menu hands it over. */
async function downloadPptx(page: Page): Promise<Buffer> {
  await page.getByTestId('slides-more').click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('slides-pptx-button').click();
  return fs.readFileSync((await (await downloading).path())!);
}

async function importFile(page: Page, name: string, buffer: Buffer | Uint8Array): Promise<void> {
  await page.getByTestId('slides-more').click();
  await expect(page.getByTestId('slides-pptx-import')).toBeVisible();
  const choosing = page.waitForEvent('filechooser');
  await page.getByTestId('slides-pptx-import').click();
  await (await choosing).setFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(buffer) });
}

test.describe('PowerPoint files brought in', () => {
  test.setTimeout(240_000);

  test('a deck made here and saved as PowerPoint comes back into a new deck whole, and is presented', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Original');
    const deckUrl = page.url();
    await typeInBox(page, 0, 'Harbour walk');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+m');
    await typeInBox(page, 0, 'Bring');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Boots');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Water');
    await page.keyboard.press('Escape');
    await page.getByTestId('speaker-notes').fill('Mention the ferry.');
    await addShapeAt(page, 'ellipse', 1100, 560);
    await page.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(400, 240) });
    await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });
    await expectSlidesSaved(page);
    const bytes = await downloadPptx(page);

    // A new deck, and the file brought into it: it takes the new deck's place.
    await page.goto(deckUrl.replace(/\/[^/]+$/, ''));
    await createPresentation(page, 'Brought in');
    await importFile(page, 'Original.pptx', bytes);
    await expect(thumbs(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(sheet(page)).toContainText('Harbour walk');
    await thumbs(page).nth(1).click();
    await expect(sheet(page)).toContainText('Boots');
    await expect(sheet(page).locator('li')).toHaveCount(2);
    await expect(elements(page, 'shape')).toHaveCount(1);
    await expect.poll(() => elements(page, 'image').locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('speaker-notes')).toHaveValue('Mention the ferry.');
    await shot(page, 'import-01-own-deck');

    // Presented, as any deck.
    await page.getByTestId('present').click();
    const presenting = page.getByTestId('present-view');
    await expect(presenting).toBeVisible();
    await expect(presenting).toContainText('Bring');
    await shot(page, 'import-02-presenting');
    await page.keyboard.press('Escape');
    await expect(presenting).toHaveCount(0);

    // Undo takes the whole import back in one step.
    await sheet(page).click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('ControlOrMeta+z');
    await expect(thumbs(page)).toHaveCount(1);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(thumbs(page)).toHaveCount(2);
    await expectSlidesSaved(page);
  });

  test('a file whose slides inherit from layout and master, dropped on a deck that has slides, comes in after them', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Dropping');
    await typeInBox(page, 0, 'Already here');
    await page.keyboard.press('Escape');
    const transfer = await page.evaluateHandle((bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'Old house.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
      return data;
    }, [...inheritedPptx()]);
    await page.dispatchEvent('[data-testid="slide-canvas"]', 'dragover', { dataTransfer: transfer });
    await page.dispatchEvent('[data-testid="slide-canvas"]', 'drop', { dataTransfer: transfer });
    await expect(thumbs(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(sheet(page)).toContainText('Old house');
    await expect(sheet(page)).toContainText('Kitchen');
    // The title wears the master's colour; the master's band is on the slide.
    const title = elements(page, 'text').filter({ hasText: 'Old house' });
    await expect(title.locator('.el-text')).toHaveCSS('color', 'rgb(180, 83, 42)');
    await expect(elements(page, 'shape')).toHaveCount(2);
    await shot(page, 'import-03-inherited');
    await thumbs(page).first().click();
    await expect(sheet(page)).toContainText('Already here');
  });

  test('a PowerPoint file beside the deck is brought in when the address asks for it', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'From the folder');
    const deckUrl = page.url();
    const folderUrl = deckUrl.replace(/\/[^/]+$/, '');
    await page.goto(folderUrl);
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'Old house.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from(inheritedPptx()) });
    await expect(page.locator('[data-testid="file-list"] a:has-text("Old house.pptx")')).toBeAttached({ timeout: 30_000 });
    await page.goto(`${deckUrl}?import=${encodeURIComponent('Old house.pptx')}`);
    await expect(sheet(page)).toContainText('Old house', { timeout: 30_000 });
    // It took the place of the new deck's empty slide, and the address no longer asks.
    await expect(thumbs(page)).toHaveCount(1);
    await expect.poll(() => page.url()).not.toContain('import=');
    await expectSlidesSaved(page);
    await page.reload();
    await expect(sheet(page)).toContainText('Old house', { timeout: 30_000 });
    await expect(thumbs(page)).toHaveCount(1);
  });
});
