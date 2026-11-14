// Several files and folders are chosen at once, as in Google Drive: with
// Ctrl/⌘ and Shift and a mouse, a row's checkbox or a rectangle drawn from
// empty space; with the arrows, Shift, Space and Ctrl/⌘+A from the keyboard;
// and on a phone by a long press, after which taps add and take away. A bar
// in place of the folder's header then moves, downloads or deletes them all.
import fs from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createFolder, expectFolderEditable, fileRow, uploadIntoFolder } from './test-utils';

const DESKTOP = { width: 1280, height: 800 };
/** Narrower than the open-file layout: the arrows step onto files without opening them. */
const LIST_ONLY = { width: 900, height: 800 };
const PHONE = { width: 390, height: 844 };

async function startInMyDrive(page: Page, relayUrl: string): Promise<void> {
  // The browser's save dialog cannot be answered from a test; the download path is checked instead.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Picker');
  await expectFolderEditable(page);
}

const text = (name: string, body = name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
const bar = (page: Page) => page.getByTestId('selection-bar');
const count = (page: Page) => bar(page).getByTestId('selection-count');
const link = (page: Page, name: string) => fileRow(page, name).getByRole('link');

/** Each row's checkbox says whether it is chosen. */
async function expectSelected(page: Page, names: string[], others: string[]): Promise<void> {
  for (const name of names) await expect(fileRow(page, name).getByRole('checkbox', { name: `Select ${name}` })).toBeChecked();
  for (const name of others) await expect(fileRow(page, name).getByRole('checkbox', { name: `Select ${name}` })).not.toBeChecked();
}

/** Draws a rectangle with the mouse from the empty space under the rows up to the middle of `toRow`. */
async function drawRectangle(page: Page, toRow: string, options: { add?: boolean } = {}): Promise<void> {
  const list = (await page.getByTestId('file-list').boundingBox())!;
  const last = (await page.getByTestId('file-row').last().boundingBox())!;
  const target = (await fileRow(page, toRow).boundingBox())!;
  const x = list.x + list.width / 2;
  await page.mouse.move(x, Math.min(last.y + last.height + 40, list.y + list.height - 10));
  if (options.add) await page.keyboard.down('ControlOrMeta');
  await page.mouse.down();
  await page.mouse.move(x - 60, target.y + target.height / 2, { steps: 6 });
  await expect(page.getByTestId('selection-rectangle')).toBeVisible();
  await page.mouse.up();
  if (options.add) await page.keyboard.up('ControlOrMeta');
  await expect(page.getByTestId('selection-rectangle')).toHaveCount(0);
}

test.describe('choosing several items', () => {
  test.setTimeout(180_000);

  test('with a mouse: Ctrl/⌘, Shift, checkboxes and a rectangle choose, and the bar acts on them all', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await startInMyDrive(page, relayUrl);
    // A Ctrl/⌘ or Shift click on a row is the browser's way to open a new tab or window: not here.
    const newPages: Page[] = [];
    page.context().on('page', (opened) => newPages.push(opened));
    await createAndEnterFolder(page, 'Trip');
    await createFolder(page, 'Archive');
    await expect(fileRow(page, 'Archive')).toBeVisible({ timeout: 30_000 });
    await uploadIntoFolder(page, [text('a.txt'), text('b.txt'), text('c.txt'), text('d.txt')]);
    const folderUrl = page.url();

    // Ctrl/⌘+click chooses one without opening it, and the bar takes the header's place.
    await link(page, 'a.txt').click({ modifiers: ['ControlOrMeta'] });
    await expect(count(page)).toHaveText('1 selected');
    await expect(page.getByTestId('folder-header')).toBeHidden();
    await expectSelected(page, ['a.txt'], ['b.txt', 'c.txt', 'd.txt']);
    await expect(page.getByRole('status').filter({ hasText: '1 selected' })).toBeAttached();

    // Shift+click chooses the rows from there to here; Ctrl/⌘+click takes one away again.
    await link(page, 'c.txt').click({ modifiers: ['Shift'] });
    await expect(count(page)).toHaveText('3 selected');
    await expectSelected(page, ['a.txt', 'b.txt', 'c.txt'], ['d.txt', 'Archive']);
    await link(page, 'b.txt').click({ modifiers: ['ControlOrMeta'] });
    await expect(count(page)).toHaveText('2 selected');
    expect(page.url()).toBe(folderUrl);
    await page.waitForTimeout(300);
    expect(newPages).toHaveLength(0);
    await page.screenshot({ path: test.info().outputPath('selection-desktop.png') });

    // Every button of the bar says what it does.
    for (const name of ['Move', 'Download', 'Delete', 'Clear selection']) {
      await expect(bar(page).getByRole('button', { name })).toBeVisible();
    }

    // Several download as one ZIP named for the folder.
    const pending = page.waitForEvent('download');
    await bar(page).getByRole('button', { name: 'Download' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Trip.zip');
    const zipped = unzipSync(new Uint8Array(await fs.readFile((await download.path())!)));
    expect(Object.keys(zipped).sort()).toEqual(['a.txt', 'c.txt']);
    expect(new TextDecoder().decode(zipped['c.txt'])).toBe('c.txt');

    // Escape lets go of them all.
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(page.getByTestId('folder-header')).toBeVisible();
    await expectSelected(page, [], ['a.txt', 'b.txt', 'c.txt', 'd.txt']);

    // Move: two at once through the dialog, chosen by the checkboxes that show on hover.
    for (const name of ['a.txt', 'b.txt']) {
      await fileRow(page, name).hover();
      await fileRow(page, name).getByRole('checkbox').click();
    }
    await expect(count(page)).toHaveText('2 selected');
    await bar(page).getByRole('button', { name: 'Move' }).click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog).toContainText('Move 2 items');
    await dialog.getByTestId('move-folder').filter({ hasText: 'Archive' }).click();
    await dialog.getByTestId('move-confirm').click();
    await expect(page.getByText('Moved 2 items to Archive')).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'a.txt')).toHaveCount(0, { timeout: 30_000 });
    await expect(fileRow(page, 'b.txt')).toHaveCount(0);
    await expect(bar(page)).toBeHidden();

    // A rectangle from empty space chooses what it touches, in place of what was chosen…
    await link(page, 'c.txt').click({ modifiers: ['ControlOrMeta'] });
    await drawRectangle(page, 'd.txt');
    await expect(count(page)).toHaveText('1 selected');
    await expectSelected(page, ['d.txt'], ['c.txt', 'Archive']);
    // …or, with Ctrl/⌘ held, besides it.
    await page.keyboard.press('Escape');
    await link(page, 'c.txt').click({ modifiers: ['ControlOrMeta'] });
    await drawRectangle(page, 'd.txt', { add: true });
    await expect(count(page)).toHaveText('2 selected');
    await expectSelected(page, ['c.txt', 'd.txt'], ['Archive']);

    // Dragging one of the chosen onto a folder takes them all there.
    await link(page, 'd.txt').dragTo(fileRow(page, 'Archive'));
    await expect(page.getByText('Moved 2 items to Archive').last()).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'c.txt')).toHaveCount(0, { timeout: 30_000 });
    await expect(fileRow(page, 'd.txt')).toHaveCount(0);
    await expect(bar(page)).toBeHidden();

    // A plain click still opens a row, and lets go of what was chosen.
    await link(page, 'Archive').click();
    await expect(page).toHaveURL(/\/Trip\/Archive$/, { timeout: 30_000 });
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await expect(fileRow(page, name)).toBeVisible({ timeout: 30_000 });
    await link(page, 'a.txt').click({ modifiers: ['ControlOrMeta'] });
    await expect(count(page)).toHaveText('1 selected');
    await link(page, 'b.txt').click();
    await expect(page.getByTestId('viewer-header')).toContainText('b.txt', { timeout: 30_000 });
    await expect(bar(page)).toBeHidden();
    await page.getByTestId('viewer-back').click();
    await expect(page).toHaveURL(/\/Trip\/Archive$/, { timeout: 30_000 });

    // Delete: everything in Archive at once, saying so.
    await page.getByTestId('file-list').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(count(page)).toHaveText('4 selected');
    await bar(page).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('empty-folder')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Deleted 4 items')).toBeVisible();
    await expect(bar(page)).toBeHidden();
    await expect(page.getByTestId('file-list')).toBeFocused();
    expect(newPages).toHaveLength(0);
  });

  test('a rectangle that reaches the top of the list scrolls it, choosing what comes into view', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await startInMyDrive(page, relayUrl);
    const names = Array.from({ length: 30 }, (_, index) => `note-${String(index).padStart(2, '0')}.txt`);
    await uploadIntoFolder(page, names.map((name) => text(name)));
    const list = page.getByTestId('file-list');
    await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const bottom = await list.evaluate((node) => node.scrollTop);
    expect(bottom).toBeGreaterThan(0);
    const box = (await list.boundingBox())!;
    const last = (await fileRow(page, names.at(-1)!).boundingBox())!;

    // From the space under the last row up to the top edge, held there.
    await page.mouse.move(box.x + box.width / 2, last.y + last.height + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + 4, { steps: 8 });
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeLessThan(bottom);
    await expect.poll(() => list.evaluate((node) => node.scrollTop), { timeout: 10_000 }).toBe(0);
    await page.mouse.up();
    await expect(count(page)).toHaveText('30 selected');
  });

  test('with the keyboard: arrows choose a row, Shift+arrows a range, Ctrl/⌘+arrows only move, Space chooses', async ({ page, relayUrl }) => {
    await page.setViewportSize(LIST_ONLY);
    await startInMyDrive(page, relayUrl);
    await createFolder(page, 'Inner');
    await expect(fileRow(page, 'Inner')).toBeVisible({ timeout: 30_000 });
    await uploadIntoFolder(page, [text('x.txt'), text('y.txt')]);
    const list = page.getByTestId('file-list');
    const focused = (name: string) => expect(fileRow(page, name)).toHaveClass(/ring-accent/);

    // An arrow moves to a row and chooses just it.
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await focused('Inner');
    await expect(count(page)).toHaveText('1 selected');
    await expectSelected(page, ['Inner'], ['x.txt', 'y.txt']);
    await expect(list).toBeFocused();

    // Shift+arrows choose from there, both ways.
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(count(page)).toHaveText('3 selected');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(count(page)).toHaveText('2 selected');
    await expectSelected(page, ['Inner', 'x.txt'], ['y.txt']);

    // A plain arrow chooses just where it goes.
    await page.keyboard.press('ArrowDown');
    await focused('y.txt');
    await expect(count(page)).toHaveText('1 selected');
    await expectSelected(page, ['y.txt'], ['Inner', 'x.txt']);

    // Ctrl/⌘+arrow only moves; Space then chooses there, and again lets go.
    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await focused('x.txt');
    await expect(count(page)).toHaveText('1 selected');
    await page.keyboard.press('Space');
    await expect(count(page)).toHaveText('2 selected');
    await expectSelected(page, ['x.txt', 'y.txt'], ['Inner']);
    await page.keyboard.press('Space');
    await expect(count(page)).toHaveText('1 selected');

    await page.keyboard.press('ControlOrMeta+a');
    await expect(count(page)).toHaveText('3 selected');
    await expectSelected(page, ['Inner', 'x.txt', 'y.txt'], []);

    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(list).toBeFocused();
    await expectSelected(page, [], ['Inner', 'x.txt', 'y.txt']);

    // Clear in the bar gives the keyboard back to the list.
    await page.keyboard.press('Space');
    await expect(bar(page)).toBeVisible();
    await bar(page).getByRole('button', { name: 'Clear selection' }).click();
    await expect(bar(page)).toBeHidden();
    await expect(list).toBeFocused();

    // Delete takes all of them at once, asking nothing; Undo puts them back.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('empty-folder')).toBeVisible({ timeout: 30_000 });
    await expect(bar(page)).toBeHidden();
    await expect(list).toBeFocused();
    await page.getByTestId('toast-action').filter({ hasText: 'Undo' }).click();
    await expectSelected(page, [], ['Inner', 'x.txt', 'y.txt']);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE, hasTouch: true });

    test('a long press starts choosing, then taps add and take away; the menu stays on ⋮', async ({ page, relayUrl }) => {
      await startInMyDrive(page, relayUrl);
      await uploadIntoFolder(page, [text('p.txt'), text('q.txt'), text('r.txt')]);
      const folderUrl = page.url();
      const press = link(page, 'p.txt');
      const box = (await press.boundingBox())!;
      const at = { pointerType: 'touch', isPrimary: true, clientX: box.x + 60, clientY: box.y + box.height / 2 };

      await press.dispatchEvent('pointerdown', at);
      await page.waitForTimeout(800);
      await press.dispatchEvent('pointerup', at);
      // The click that ends the press only lifts the finger.
      await press.dispatchEvent('click');
      await expect(count(page)).toHaveText('1 selected');
      await expect(page.getByTestId('row-menu')).toBeHidden();
      expect(page.url()).toBe(folderUrl);

      // Android tells of the same press with a contextmenu event: still choosing, no menu.
      await link(page, 'r.txt').dispatchEvent('pointerdown', at);
      await link(page, 'r.txt').dispatchEvent('contextmenu', at);
      await link(page, 'r.txt').dispatchEvent('pointerup', at);
      await expect(count(page)).toHaveText('2 selected');
      await expect(page.getByTestId('row-menu')).toBeHidden();

      await link(page, 'q.txt').tap();
      await expect(count(page)).toHaveText('3 selected');
      await link(page, 'p.txt').tap();
      await expect(count(page)).toHaveText('2 selected');
      await expectSelected(page, ['q.txt', 'r.txt'], ['p.txt']);
      expect(page.url()).toBe(folderUrl);
      await page.screenshot({ path: test.info().outputPath('selection-phone.png') });

      // The bar fits the phone, each button named.
      for (const name of ['Move', 'Download', 'Delete', 'Clear selection']) {
        const button = bar(page).getByRole('button', { name });
        await expect(button).toBeVisible();
        const place = (await button.boundingBox())!;
        expect(place.x >= 0 && place.x + place.width <= PHONE.width).toBe(true);
      }

      // ⋮ still opens a row's menu.
      await fileRow(page, 'p.txt').getByTestId('row-menu-btn').click();
      await expect(page.getByTestId('row-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('row-menu')).toBeHidden();

      await bar(page).getByRole('button', { name: 'Clear selection' }).click();
      await expect(bar(page)).toBeHidden();

      // With nothing chosen a tap opens the file again.
      await link(page, 'q.txt').tap();
      await expect(page.getByTestId('viewer-header')).toContainText('q.txt', { timeout: 30_000 });
    });
  });
});
