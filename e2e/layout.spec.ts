import { expect, test, type Page } from './fixtures';
import { createDocument, createDriveProfile, prepareFreshSession, typeInDocument } from './documents.helpers';
import { chooseNew } from './test-utils';

const sizes = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 900, height: 700 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

const shots = process.env.LAYOUT_SHOTS_DIR;

async function atEachSize(page: Page, name: string, check: (width: number) => Promise<void>): Promise<void> {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await check(size.width);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${size.width}.png` });
  }
  await page.setViewportSize(sizes[1]);
}

/** Nothing in the folder header is cut off or pushed out of the window. */
async function expectFolderHeaderFits(page: Page, title: string, width: number): Promise<void> {
  const header = page.getByTestId('folder-header');
  const heading = header.getByRole('heading', { name: title });
  await expect(heading).toBeVisible();
  if (width >= 768 || title.length < 12) {
    await expect.poll(() => heading.evaluate((el) => el.scrollWidth - el.clientWidth), {
      message: `"${title}" is shown in full at ${width}px`,
    }).toBeLessThanOrEqual(0);
  } else {
    // A long name on a phone may be shortened, but keeps most of the row.
    await expect.poll(() => heading.evaluate((el) => el.clientWidth), {
      message: `"${title}" keeps room at ${width}px`,
    }).toBeGreaterThan(width * 0.4);
  }
  for (const control of await header.locator('a:visible, button:visible, label:visible').all()) {
    const box = await control.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width, `a header control is inside the window at ${width}px`).toBe(true);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test.describe('layout at different window sizes', () => {
  test.setTimeout(240_000);

  test('the folder header and the document editor fit the window', async ({ page, relayUrl }) => {
    await page.setViewportSize(sizes[1]);
    if (process.env.LAYOUT_DARK) await page.emulateMedia({ colorScheme: 'dark' });
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Liminal Forest');
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });

    await atEachSize(page, 'folder', (width) => expectFolderHeaderFits(page, 'My Drive', width));

    // The less common actions are behind one button.
    for (const size of [sizes[1], sizes[6]]) {
      await page.setViewportSize(size);
      await page.getByTestId('folder-menu-btn').filter({ visible: true }).click();
      const menu = page.getByTestId('folder-menu');
      await expect(menu.getByRole('menuitem', { name: 'Download ZIP' })).toBeVisible();
      const box = await menu.boundingBox();
      expect(box && box.x >= 0 && box.x + box.width <= size.width, 'the menu is inside the window').toBe(true);
      if (shots) await page.screenshot({ path: `${shots}/folder-menu-${size.width}.png` });
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    await page.setViewportSize(sizes[1]);

    // A folder inside another shows the way back up.
    const folderName = 'Quarterly planning and budgets';
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill(folderName);
    await page.getByPlaceholder('Folder name...').press('Enter');
    await page.getByTestId('file-list').getByRole('link', { name: folderName }).dblclick();
    await expect(page.getByTestId('folder-header').getByRole('heading', { name: folderName })).toBeVisible();
    await atEachSize(page, 'subfolder', (width) => expectFolderHeaderFits(page, folderName, width));
    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My Drive' }).click();
    await expect(page.getByTestId('folder-header').getByRole('heading', { name: 'My Drive' })).toBeVisible();

    await createDocument(page, 'test doc');
    await typeInDocument(page, 'Pack the tent');
    await atEachSize(page, 'document', async (width) => {
      // The document has the width to itself, and the toolbar starts at its first button.
      await expect(page.getByTestId('file-list')).toBeHidden();
      const toolbar = await page.getByTestId('document-toolbar').boundingBox();
      const undo = await page.getByRole('button', { name: 'Undo' }).boundingBox();
      expect(toolbar && undo && undo.x >= toolbar.x, `Undo is not cut off at ${width}px`).toBe(true);
      // Saving shows no moving indicator.
      await expect(page.getByTestId('document-save-status').locator('.animate-spin')).toHaveCount(0);
    });

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByTestId('document-entry').filter({ visible: true })).toHaveCount(1);
    await atEachSize(page, 'folder-list', (width) => expectFolderHeaderFits(page, 'My Drive', width));
  });
});
