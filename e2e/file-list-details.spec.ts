// The list says when each item last changed and how big each file is, as
// Google Drive does, and sorts by name, last change or size, folders first.
// The order chosen is kept on this device.
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from './fixtures';
import { createDocument, createDriveProfile, expectSaved, prepareFreshSession, typeInDocument } from './documents.helpers';
import { jpeg, picture } from './photos.helpers';
import { createFolder, expectFolderEditable, fileRow, uploadIntoFolder } from './test-utils';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** Today's changes show the time, as "10:42" or "10:42 AM". */
const TIME = /^\d{1,2}[:.]\d{2}(\s?[AP]M)?$/;

const sized = (name: string, bytes: number) => ({ name, mimeType: 'text/plain', buffer: Buffer.alloc(bytes, 'x') });

/** The names in the list, top to bottom. */
function listed(page: Page): Promise<string[]> {
  return page.getByTestId('file-list').getByTestId('file-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-entry-name') ?? ''));
}

async function modifiedAt(page: Page, row: ReturnType<typeof fileRow>): Promise<number> {
  const value = await row.getByTestId('row-modified').locator('time').getAttribute('datetime');
  return Date.parse(value!);
}

test.describe('the list of a folder', () => {
  test.setTimeout(180_000);

  test('grid previews photos, keeps list actions and remembers the layout', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Grid');
    await expectFolderEditable(page);
    await createFolder(page, 'Albums');
    await uploadIntoFolder(page, jpeg('Meadow.jpg', await picture(page, '#87cfff', '#227744', 720, 480)));
    await uploadIntoFolder(page, sized('Notes.txt', 12));
    const grid = page.getByRole('button', { name: 'Grid view', exact: true });
    await grid.click();
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    const photo = fileRow(page, 'Meadow.jpg');
    const preview = photo.locator('img');
    await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(photo.getByRole('link', { name: 'Meadow.jpg', exact: true })).toBeVisible();
    await photo.getByTestId('row-menu-btn').click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await page.keyboard.press('Escape');
    // A mouse on ⋮ chose the photo; its checkbox drops it and chooses it again.
    await photo.hover();
    await photo.getByRole('checkbox').click();
    await expect(page.getByTestId('selection-count')).toHaveCount(0);
    await photo.getByRole('checkbox').click();
    await expect(page.getByTestId('selection-count')).toHaveText('1 selected');
    await page.getByRole('button', { name: 'Clear selection' }).click();
    // A rectangle over the photo leaves the neighbouring card on its right alone.
    const tile = (await photo.boundingBox())!;
    await page.mouse.move(tile.x + 4, tile.y - 4);
    await page.mouse.down();
    await page.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(photo.getByRole('checkbox')).toBeChecked();
    await expect(fileRow(page, 'Notes.txt').getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await page.screenshot({ path: testInfo.outputPath('folder-grid-desktop.png') });
    await page.reload();
    await expect(grid).toHaveAttribute('aria-pressed', 'true');
    await page.setViewportSize(PHONE);
    await expect(photo.locator('img')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('folder-grid-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await fileRow(page, 'Albums').getByRole('link').dblclick();
    await expect(page.getByTestId('folder-header').getByRole('heading')).toHaveText('Albums');
    await page.goBack();
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await expect(photo.locator('img')).toHaveCount(0);
  });

  test('List and Grid stay in place when the layout, scrollbars or selected items change', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Layout');
    await expectFolderEditable(page);
    await uploadIntoFolder(page, Array.from({ length: 10 }, (_, n) => sized(`Note ${n}.txt`, 10)));
    const views = page.getByRole('group', { name: 'Folder view' });
    const list = views.getByRole('button', { name: 'List view' });
    const grid = views.getByRole('button', { name: 'Grid view' });
    const folder = page.getByTestId('file-list');
    await page.addStyleTag({ content: '[data-scroll-root]::-webkit-scrollbar { width: 16px; }' });
    const box = async () => Promise.all([views, list, grid].map(element => element.boundingBox()));
    const evidence: Record<string, unknown> = {};
    for (const width of [1280, 850, 650, 350]) {
      await page.setViewportSize({ width, height: 480 });
      await list.click();
      const start = await box();
      expect(start.every(Boolean)).toBe(true);
      const still = async (step: string) => {
        const actual = await box();
        evidence[`${width} ${step}`] = actual;
        expect(actual, `${width}px: ${step}`).toEqual(start);
      };
      await grid.focus();
      await grid.press('Enter');
      await expect(folder).toHaveAttribute('data-layout', 'grid');
      await still('keyboard grid');
      for (const n of [0, 1]) {
        const row = fileRow(page, `Note ${n}.txt`);
        await row.getByRole('link').click({ modifiers: ['ControlOrMeta'] });
        await expect(page.getByTestId('selection-count')).toHaveText(`${n + 1} selected`);
        await still(`${n + 1} selected`);
      }
      await list.click();
      await expect(folder).toHaveAttribute('data-layout', 'list');
      await still('list with selection');
      await folder.evaluate(node => { node.scrollTop = node.scrollHeight; });
      expect(await folder.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await still('scrolled');
      await folder.evaluate(node => { node.style.overflowY = 'hidden'; });
      await still('scrollbar removed');
      await folder.evaluate(node => { node.style.removeProperty('overflow-y'); });
      await page.getByRole('button', { name: 'Clear selection' }).click();
      await still('cleared');
    }
    const path = testInfo.outputPath('toolbar-positions.json');
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach('toolbar-positions', { path, contentType: 'application/json' });
  });

  test('shows when each item changed and how big each file is, on a phone in a second line', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Dates');
    await expectFolderEditable(page);
    await createFolder(page, 'Photos');
    await expect(fileRow(page, 'Photos')).toBeVisible({ timeout: 30_000 });
    await uploadIntoFolder(page, sized('notes.txt', 12));

    const header = page.getByTestId('list-header');
    await expect(header.getByRole('button', { name: 'Last modified', exact: true })).toBeVisible();
    await expect(header.getByRole('button', { name: 'File size', exact: true })).toBeVisible();

    const notes = fileRow(page, 'notes.txt');
    await expect(notes.getByTestId('row-modified')).toHaveText(TIME);
    await expect(notes.getByTestId('row-size')).toHaveText('12 B');
    // The whole date and time on hover.
    await expect(notes.getByTestId('row-modified').locator('time')).toHaveAttribute('title', new RegExp(String(new Date().getFullYear())));
    const photos = fileRow(page, 'Photos');
    await expect(photos.getByTestId('row-modified')).toHaveText(TIME);
    await expect(photos.getByTestId('row-size')).toHaveText('—');
    await page.screenshot({ path: test.info().outputPath('dates-desktop.png') });

    // A document is changed when it is saved, not only when it was made.
    await createDocument(page, 'Plans');
    // Made, not yet saved: its time is when it was made.
    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    const plans = page.getByTestId('file-row').filter({ has: page.getByTestId('document-entry') });
    await expect(plans.getByTestId('row-modified')).toHaveText(TIME, { timeout: 30_000 });
    const made = await modifiedAt(page, plans);
    await page.waitForTimeout(1_100);
    await plans.getByRole('link').dblclick();
    await typeInDocument(page, 'Bring the tent');
    await expectSaved(page);
    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    await expect.poll(() => modifiedAt(page, plans), { timeout: 30_000 }).toBeGreaterThan(made);

    // On a phone the columns give way to a second line under the name.
    await page.setViewportSize(PHONE);
    await expect(notes.getByTestId('row-modified')).toBeHidden();
    await expect(notes.getByTestId('row-size')).toBeHidden();
    await expect(notes.getByTestId('row-details')).toBeVisible();
    await expect(notes.getByTestId('row-details')).toHaveText(/^\d{1,2}[:.]\d{2}(\s?[AP]M)? · 12 B$/);
    await expect(page.getByTestId('list-header').getByRole('button', { name: 'Last modified', exact: true })).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath('dates-phone.png') });
  });

  test('shows when each file changed for the very first upload of a new Drive', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'First');
    await expectFolderEditable(page);
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    await uploadIntoFolder(page, names.map((name) => sized(name, 1)));
    for (const name of names) await expect(fileRow(page, name).getByTestId('row-modified')).toHaveText(TIME);
  });

  test('sorts by name, last change or size, folders first, and keeps the order on this device', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Sorter');
    await expectFolderEditable(page);
    // Each a second apart, so their times differ.
    await createFolder(page, 'Zeta');
    await expect(fileRow(page, 'Zeta')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_100);
    await createFolder(page, 'Alpha');
    await expect(fileRow(page, 'Alpha')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_100);
    await uploadIntoFolder(page, sized('b.txt', 1));
    await page.waitForTimeout(1_100);
    await uploadIntoFolder(page, sized('a.txt', 3000));
    await page.waitForTimeout(1_100);
    await uploadIntoFolder(page, sized('c.txt', 100));

    const header = page.getByTestId('list-header');
    const sortButton = header.getByTestId('sort-menu-btn');
    await expect(sortButton).toHaveAccessibleName('Sort by Name, A to Z');
    expect(await listed(page)).toEqual(['Alpha', 'Zeta', 'a.txt', 'b.txt', 'c.txt']);

    // Newest first, then oldest first.
    await header.getByRole('button', { name: 'Last modified', exact: true }).click();
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Zeta', 'c.txt', 'a.txt', 'b.txt']);
    await header.getByRole('button', { name: 'Last modified', exact: true }).click();
    await expect.poll(() => listed(page)).toEqual(['Zeta', 'Alpha', 'b.txt', 'a.txt', 'c.txt']);

    // Size from the small menu: largest first.
    await sortButton.click();
    const menu = page.getByTestId('sort-menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Name', 'Last modified', 'Size']);
    await menu.getByRole('menuitem', { name: 'Size' }).click();
    await expect(menu).toBeHidden();
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Zeta', 'a.txt', 'c.txt', 'b.txt']);
    await expect(sortButton).toHaveAccessibleName('Sort by Size, largest first');
    await expect(sortButton).toBeFocused();

    // Kept on this device.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(fileRow(page, 'c.txt')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Zeta', 'a.txt', 'c.txt', 'b.txt']);
    await expect(page.getByTestId('list-header').getByTestId('sort-menu-btn')).toHaveAccessibleName('Sort by Size, largest first');

    // Choosing what it is already sorted by turns the order around.
    await page.getByTestId('list-header').getByTestId('sort-menu-btn').click();
    await page.getByTestId('sort-menu').getByRole('menuitem', { name: 'Name' }).click();
    await expect.poll(() => listed(page)).toEqual(['Alpha', 'Zeta', 'a.txt', 'b.txt', 'c.txt']);
    await page.getByTestId('list-header').getByTestId('sort-menu-btn').click();
    await page.getByTestId('sort-menu').getByRole('menuitem', { name: 'Name' }).click();
    await expect.poll(() => listed(page)).toEqual(['Zeta', 'Alpha', 'c.txt', 'b.txt', 'a.txt']);
    await expect(page.getByTestId('list-header').getByTestId('sort-menu-btn')).toHaveAccessibleName('Sort by Name, Z to A');
  });
});
