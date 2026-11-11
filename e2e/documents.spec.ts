import { expect, test } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

test.describe('documents in a Drive', () => {
  test.setTimeout(180_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a new document keeps what was written after a reload', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page);
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });

    await createDocument(page, 'Trip plan');
    await expect(page).toHaveURL(/Trip%20plan\.irisdoc$/);
    await typeInDocument(page, 'Pack the tent');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Buy maps');
    await expectSaved(page);
    await page.screenshot({ path: testInfo.outputPath('document-editing.png') });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Pack the tent', { timeout: 60_000 });
    await expect(documentBody(page)).toContainText('Buy maps');

    // The document shows as one item in its folder, under its title.
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByRole('link', { name: /^Trip plan\b/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('document-in-folder.png') });
  });

  test('formatting and images survive, and a shared link opens read-only for someone else', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Field notes');

    await typeInDocument(page, 'Summary');
    await page.getByTestId('document-text-style').selectOption('h1');
    await expect(page.getByTestId('document-text-style')).toHaveValue('h1');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Seen today: ');
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    // Typing straight after a toolbar button lands in the text.
    await page.keyboard.type('two herons');
    await expect(documentBody(page).locator('strong')).toHaveText('two herons');
    await page.waitForTimeout(700);
    await page.keyboard.type(' and a kite');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(documentBody(page)).not.toContainText('and a kite');
    await expect(documentBody(page).locator('strong')).toHaveText('two herons');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(documentBody(page).locator('strong')).toHaveText('two herons and a kite');
    await page.getByRole('button', { name: 'Undo' }).click();

    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: pixel });
    const loadedImages = (target: typeof page) => documentBody(target).locator('img').evaluateAll(
      images => images.filter(image => (image as HTMLImageElement).naturalWidth > 0).length,
    );
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toBe(1);
    await expectSaved(page);
    await page.screenshot({ path: testInfo.outputPath('formatted.png') });

    // The image is still there after a reload, served from the Drive.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page).locator('h1')).toHaveText('Summary', { timeout: 60_000 });
    await expect.poll(() => loadedImages(page), { timeout: 30_000 }).toBe(1);

    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(sharedUrl).toMatch(/#\/nhash1[a-z0-9]+\?doc=Field%20notes$/);
    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(`${new URL(guest.url()).origin}/#${sharedUrl.split('#')[1]}`);
      await expect(guest.getByTestId('document-title')).toHaveText('Field notes', { timeout: 60_000 });
      await expect(documentBody(guest).locator('h1')).toHaveText('Summary', { timeout: 60_000 });
      await expect(documentBody(guest).locator('strong')).toHaveText('two herons');
      await expect.poll(() => loadedImages(guest), { timeout: 30_000 }).toBe(1);
      await expect(guest.getByTestId('document-view-only')).toBeVisible();
      await expect(guest.getByTestId('document-toolbar')).toHaveCount(0);
      await expect(documentBody(guest)).toHaveAttribute('contenteditable', 'false');
      await guest.screenshot({ path: testInfo.outputPath('guest.png') });
    } finally {
      await guestContext.close();
    }
  });
});
