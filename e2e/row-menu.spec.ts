// Each file and folder in the list has a menu of what can be done with it:
// from its ⋮ button, a right click, the menu key or Shift+F10. On a phone it
// rises from the bottom as the New menu does; a long press there chooses the
// row instead (e2e/file-list-selection.spec.ts).
import fs from 'node:fs/promises';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createFolder, expectFolderEditable, fileRow, openRowMenu, uploadIntoFolder } from './test-utils';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function startInMyDrive(page: Page, relayUrl: string): Promise<void> {
  // The browser's save dialog cannot be answered from a test; the download path is checked instead.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Row Menus');
  await expectFolderEditable(page);
}

const menu = (page: Page) => page.getByTestId('row-menu');

test.describe('the menu of a row', () => {
  test.setTimeout(180_000);

  test('opens from ⋮, a right click and the keyboard, and does what it says', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize(DESKTOP);
    await startInMyDrive(page, relayUrl);
    await createFolder(page, 'Trip');
    await expect(fileRow(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await uploadIntoFolder(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Packing list') });
    const folderUrl = page.url();

    // ⋮ on a file: what applies to a file, in plain words.
    let opened = await openRowMenu(page, 'notes.txt');
    await expect(opened.getByRole('menuitem')).toHaveText(['Open', 'Share', 'Copy link', 'Rename', 'Move', 'Make a copy', 'Download', 'Delete']);
    await expect(opened.getByRole('menuitem').first()).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('row-menu-desktop.png') });
    const pending = page.waitForEvent('download');
    await opened.getByRole('menuitem', { name: 'Download' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('notes.txt');
    expect((await fs.readFile((await download.path())!)).toString()).toBe('Packing list');
    await expect(menu(page)).toBeHidden();

    opened = await openRowMenu(page, 'notes.txt');
    await opened.getByRole('menuitem', { name: 'Share' }).click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toBeHidden();

    opened = await openRowMenu(page, 'notes.txt');
    await opened.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByPlaceholder('New name...').fill('packing.txt');
    await page.getByPlaceholder('New name...').press('Enter');
    await expect(fileRow(page, 'packing.txt')).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'notes.txt')).toHaveCount(0);
    expect(page.url()).toBe(folderUrl);

    // A right click on a folder: copied with what is in it.
    await fileRow(page, 'Trip').getByRole('link').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Share', 'Copy link', 'Rename', 'Move', 'Make a copy', 'Download', 'Delete']);
    await menu(page).getByRole('menuitem', { name: 'Make a copy' }).click();
    await expect(fileRow(page, 'Copy of Trip')).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(folderUrl);

    // The keyboard: the menu key and Shift+F10 open it on the row picked with the arrows.
    await page.getByTestId('file-list').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ContextMenu');
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu(page).getByRole('menuitem').nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(page.getByTestId('file-list')).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();

    // Moving into a folder, and deleting.
    opened = await openRowMenu(page, 'packing.txt');
    await opened.getByRole('menuitem', { name: 'Move' }).click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('move-folder').filter({ has: page.getByText('Trip', { exact: true }) }).click();
    await dialog.getByTestId('move-confirm').click();
    await expect(fileRow(page, 'packing.txt')).toHaveCount(0, { timeout: 30_000 });

    opened = await openRowMenu(page, 'Copy of Trip');
    await opened.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'Copy of Trip')).toHaveCount(0, { timeout: 30_000 });

    // Open goes where the row goes.
    opened = await openRowMenu(page, 'Trip');
    await opened.getByRole('menuitem', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await expect(fileRow(page, 'packing.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('Copy link copies where the item opens, and Make a copy copies a file beside it', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await startInMyDrive(page, relayUrl);
    await uploadIntoFolder(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Buy bread') });
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    // Shared with no one: its address in Drive, which opens for whoever it is shared with.
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied')).toBeVisible();
    const own = new URL(page.url());
    expect(await clipboard()).toBe(`${own.origin}${own.pathname}${own.hash}/notes.txt`);

    // Anyone with the link: that link.
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Share' }).click();
    await page.getByTestId('general-access-select').selectOption('link');
    await page.getByTestId('general-access-link').click({ timeout: 30_000 });
    const link = await clipboard();
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/[^?]+\?k=[0-9a-f]+$/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Copy link' }).click();
    await expect.poll(clipboard).toBe(link);

    // A copy of a file, as of a folder: beside it, the same inside.
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Make a copy' }).click();
    await expect(fileRow(page, 'Copy of notes.txt')).toBeVisible({ timeout: 30_000 });
    await fileRow(page, 'Copy of notes.txt').getByRole('link').click();
    await expect(page.locator('pre')).toContainText('Buy bread', { timeout: 30_000 });
  });

  test('on a phone ⋮ opens it from the bottom, and a long press chooses the row instead', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize(PHONE);
    await startInMyDrive(page, relayUrl);
    await uploadIntoFolder(page, { name: 'photo-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Sunset') });
    const folderUrl = page.url();
    const link = fileRow(page, 'photo-notes.txt').getByRole('link');
    const box = (await link.boundingBox())!;
    const at = { pointerType: 'touch', isPrimary: true, clientX: box.x + 60, clientY: box.y + box.height / 2 };

    await link.dispatchEvent('pointerdown', at);
    await page.waitForTimeout(800);
    await link.dispatchEvent('pointerup', at);
    // The click that ends the press only lifts the finger.
    await link.dispatchEvent('click');
    await expect(page.getByTestId('selection-bar')).toBeVisible();
    await expect(menu(page)).toBeHidden();
    expect(page.url()).toBe(folderUrl);
    await page.getByTestId('selection-bar').getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByTestId('selection-bar')).toBeHidden();

    await fileRow(page, 'photo-notes.txt').getByTestId('row-menu-btn').click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem')).toHaveText(['Open', 'Share', 'Copy link', 'Rename', 'Move', 'Make a copy', 'Download', 'Delete']);
    const sheet = (await menu(page).boundingBox())!;
    expect(sheet.x).toBe(0);
    expect(Math.round(sheet.y + sheet.height)).toBe(PHONE.height);
    for (const item of await menu(page).getByRole('menuitem').all()) {
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    expect(page.url()).toBe(folderUrl);
    await page.screenshot({ path: testInfo.outputPath('row-menu-phone.png') });

    // A tap beside the sheet only closes it.
    await page.mouse.click(PHONE.width / 2, 100);
    await expect(menu(page)).toBeHidden();
    expect(page.url()).toBe(folderUrl);

    // A finger that moves is scrolling, not pressing.
    await link.dispatchEvent('pointerdown', at);
    await link.dispatchEvent('pointermove', { ...at, clientY: at.clientY + 40 });
    await page.waitForTimeout(800);
    await expect(menu(page)).toBeHidden();
    await expect(page.getByTestId('selection-bar')).toBeHidden();
    await link.dispatchEvent('pointercancel', at);

    // The ⋮ button is there on a phone too.
    await fileRow(page, 'photo-notes.txt').getByTestId('row-menu-btn').click();
    await expect(menu(page)).toBeVisible();
    await menu(page).getByRole('menuitem', { name: 'Open' }).click();
    await expect(page.getByTestId('viewer-header')).toContainText('photo-notes.txt', { timeout: 30_000 });
  });
});
