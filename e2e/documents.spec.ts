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

  test('two tabs of one browser show each other\'s typing and only one of them saves', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Tabs');
    await typeInDocument(page, 'First tab.');
    await expectSaved(page);

    const second = await context.newPage();
    await second.goto(page.url());
    await expect(documentBody(second)).toContainText('First tab.', { timeout: 60_000 });
    await expect(second.getByTestId('document-save-status')).toHaveText('Open in another tab');

    // The second tab's typing shows in the first at once and is saved by it.
    await typeInDocument(second, ' Second tab.');
    await expect(documentBody(page)).toContainText('Second tab.', { timeout: 5_000 });
    await expectSaved(page);

    // Closing the saving tab hands saving to the one that is left.
    await page.close();
    await typeInDocument(second, ' After the first tab closed.');
    await expectSaved(second);
    await second.reload({ waitUntil: 'domcontentloaded' });
    for (const text of ['First tab.', 'Second tab.', 'After the first tab closed.']) {
      await expect(documentBody(second)).toContainText(text, { timeout: 60_000 });
    }
  });

  test('a long document folds its change files, and deleting it leaves its neighbours alone', async ({ page, relayUrl }) => {
    await page.addInitScript(() => {
      (window as unknown as { __documentFolding?: object }).__documentFolding = { maxChanges: 3, quietMs: 0 };
    });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await page.locator('label[title="Add files"]:visible input[type="file"]').setInputFiles({
      name: 'neighbour.txt', mimeType: 'text/plain', buffer: Buffer.from('still here'),
    });
    await expect(page.getByTestId('viewer-header')).toContainText('neighbour.txt', { timeout: 30_000 });
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Log');

    for (let entry = 1; entry <= 8; entry += 1) {
      await typeInDocument(page, `Entry ${entry}. `);
      await expectSaved(page);
    }
    const storedFiles = () => page.evaluate(async () => {
      const { parseRoute } = await import('/src/utils/route.ts');
      const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
      const { getTree } = await import('/src/store.ts');
      const route = parseRoute();
      const tree = getTree();
      const root = getTreeRootSync(route.npub, route.treeName);
      const updates = root && await tree.resolvePath(root, [...route.path, 'updates']);
      if (!updates) return [];
      const names: string[] = [];
      for (const folder of await tree.listDirectory(updates.cid)) {
        for (const file of await tree.listDirectory(folder.cid)) names.push(`${folder.name.replace(/^[0-9a-f]+-/, '')}/${file.name === 'base' ? 'base' : 'change'}`);
      }
      return names.sort();
    });
    // Three changes fill a folder and the next save starts a new one from a full copy:
    // after eight saves two folders have been folded away and the third holds just that copy.
    await expect.poll(storedFiles, { timeout: 30_000 }).toEqual(['2/base']);

    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let entry = 1; entry <= 8; entry += 1) {
      await expect(documentBody(page)).toContainText(`Entry ${entry}.`, { timeout: 60_000 });
    }
    await expect.poll(storedFiles, { timeout: 30_000 }).toEqual(['2/base']);

    page.once('dialog', dialog => void dialog.accept());
    await page.getByTestId('document-delete').click();
    await expect(page.getByRole('link', { name: /^neighbour\.txt\b/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('document-entry')).toHaveCount(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('link', { name: /^neighbour\.txt\b/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('document-entry')).toHaveCount(0);
  });
});
