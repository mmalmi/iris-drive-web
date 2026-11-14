// One New menu makes and adds everything: in the sidebar on a wide window,
// floating at the bottom of a phone. With NEW_MENU_SHOTS set it saves
// screenshots of it (NEW_MENU_DARK=1 for dark).
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew, expectFolderEditable, newMenuButton, openFolderMenu, uploadFilesInput } from './test-utils';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const ITEMS = ['Folder', 'Document', 'Spreadsheet', 'Presentation', 'Form', 'Text file', 'Upload files', 'Upload folder'];
const shots = process.env.NEW_MENU_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, `${name}-${process.env.NEW_MENU_DARK ? 'dark' : 'light'}.png`) });
}

function menu(page: Page) {
  return page.getByRole('menu', { name: 'New' });
}

function item(page: Page, name: string) {
  return menu(page).getByRole('menuitem', { name, exact: true });
}

function listed(page: Page, name: string | RegExp) {
  return page.getByTestId('file-list').getByRole('link', { name });
}

async function nameIt(page: Page, placeholder: string, name: string): Promise<void> {
  await page.getByPlaceholder(placeholder).fill(name);
  await page.getByPlaceholder(placeholder).press('Enter');
}

async function startInMyDrive(page: Page, relayUrl: string): Promise<{ profileId: string }> {
  if (process.env.NEW_MENU_DARK) await page.emulateMedia({ colorScheme: 'dark' });
  await prepareFreshSession(page, relayUrl);
  const owner = await createDriveProfile(page, 'Liminal Forest');
  await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });
  await expectFolderEditable(page);
  return owner;
}

test.describe('the New menu', () => {
  test.setTimeout(240_000);

  test('files uploaded from New land in the folder that is open, from every New button', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    const owner = await startInMyDrive(page, relayUrl);
    const cases = [
      { name: 'wide', size: DESKTOP, button: () => page.getByTestId('drive-sidebar').getByTestId('new-menu') },
      { name: 'rail', size: { width: 1000, height: 800 }, button: () => page.getByTestId('drive-sidebar').getByTestId('new-menu') },
      { name: 'narrow', size: { width: 700, height: 800 }, button: () => page.getByTestId('folder-header').getByRole('button', { name: 'New' }) },
      { name: 'phone', size: PHONE, button: () => newMenuButton(page) },
      { name: 'empty', size: DESKTOP, button: () => page.getByTestId('empty-folder-new') },
    ];
    for (const { name, size, button } of cases) {
      await page.setViewportSize(size);
      await page.goto(`/#/${owner.profileId}/main`);
      await chooseNew(page, 'Folder');
      await nameIt(page, 'Folder name...', `In ${name}`);
      await listed(page, new RegExp(`^In ${name}`)).first().click();
      await expect(page).toHaveURL(new RegExp(`/main/In(%20| )${name}$`), { timeout: 30_000 });
      await expect(page.getByTestId('empty-folder')).toBeVisible({ timeout: 30_000 });
      await button().click();
      const chooser = page.waitForEvent('filechooser');
      await item(page, 'Upload files').click();
      await (await chooser).setFiles({ name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from(name) });
      await expect(listed(page, new RegExp(`^${name}\\.txt`)).first()).toBeVisible({ timeout: 30_000 });
    }
    // None of them went to My Drive.
    await page.setViewportSize(DESKTOP);
    await page.goto(`/#/${owner.profileId}/main`);
    await expect(listed(page, /^In wide/).first()).toBeVisible({ timeout: 30_000 });
    for (const { name } of cases) await expect(listed(page, new RegExp(`^${name}\\.txt`))).toHaveCount(0);
  });

  test('the New in an empty folder stays open until it is used', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    await startInMyDrive(page, relayUrl);
    const button = page.getByTestId('empty-folder-new');
    await button.click();
    const menu = page.getByRole('menu').filter({ visible: true });
    await expect(menu).toBeVisible();
    await button.evaluate((element) => { (element as HTMLElement & { opened?: boolean }).opened = true; });
    // Longer than the folder takes to look for what may still be on its way, more than once.
    await page.waitForTimeout(4_000);
    await expect(menu).toBeVisible();
    expect(await button.evaluate((element) => (element as HTMLElement & { opened?: boolean }).opened)).toBe(true);
  });

  test('on a wide window it opens from the sidebar, by mouse and by keyboard, and makes each kind', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    const owner = await startInMyDrive(page, relayUrl);
    const button = page.getByTestId('drive-sidebar').getByTestId('new-menu');

    // The folder's header has no buttons for making things: they are all behind New.
    const header = page.getByTestId('folder-header');
    await expect(header.getByRole('button', { name: /New|Add/ })).toHaveCount(0);
    await shot(page, 'desktop-folder');

    await button.click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(ITEMS);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await shot(page, 'desktop-menu');
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button).toBeFocused();

    // A click elsewhere closes it.
    await button.click();
    await expect(menu(page)).toBeVisible();
    await page.getByTestId('file-list').click({ position: { x: 300, y: 200 } });
    await expect(menu(page)).toBeHidden();

    // Keyboard: Enter opens on the first item, the arrows move and wrap, Escape returns.
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(item(page, 'Folder')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item(page, 'Document')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(item(page, 'Upload folder')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press(' ');
    await expect(item(page, 'Folder')).toBeFocused();
    await page.keyboard.press('Enter');
    await nameIt(page, 'Folder name...', 'Trip photos');
    await expect(listed(page, 'Trip photos')).toBeVisible({ timeout: 30_000 });

    await chooseNew(page, 'Text file');
    await nameIt(page, 'File name...', 'packing.txt');
    await expect(page).toHaveURL(/packing\.txt\?edit=1/, { timeout: 30_000 });
    await page.goto(`/#/${owner.profileId}/main`);

    const kinds = [
      { choice: 'Document', placeholder: 'Document name...', extension: 'irisdoc' },
      { choice: 'Spreadsheet', placeholder: 'Spreadsheet name...', extension: 'irissheet' },
      { choice: 'Presentation', placeholder: 'Presentation name...', extension: 'irisslides' },
      { choice: 'Form', placeholder: 'Form name...', extension: 'irisform' },
    ] as const;
    for (const kind of kinds) {
      await chooseNew(page, kind.choice);
      await nameIt(page, kind.placeholder, `Plan ${kind.choice}`);
      await expect(page).toHaveURL(new RegExp(`Plan%20${kind.choice}\\.${kind.extension}$`), { timeout: 30_000 });
      await expect(page.getByTestId('document-title')).toHaveText(`Plan ${kind.choice}`, { timeout: 30_000 });
      await page.goto(`/#/${owner.profileId}/main`);
    }
    await expect(page.getByTestId('document-entry').filter({ visible: true })).toHaveCount(4, { timeout: 30_000 });

    // Uploading opens the device's own chooser.
    const files = page.waitForEvent('filechooser');
    await chooseNew(page, 'Upload files');
    await (await files).setFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(listed(page, /hello\.txt/)).toBeVisible({ timeout: 30_000 });
    // One file added is opened; back to the folder.
    await page.goto(`/#/${owner.profileId}/main`);

    const folder = test.info().outputPath('Holiday');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'beach.txt'), 'sand');
    const folderChooser = page.waitForEvent('filechooser');
    await chooseNew(page, 'Upload folder');
    await (await folderChooser).setFiles(folder);
    await expect(listed(page, 'Holiday')).toBeVisible({ timeout: 30_000 });

    // From Recent, New makes things in My Drive.
    await page.goto('/#/recent');
    await newMenuButton(page).click();
    await item(page, 'Folder').click();
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main$`));
    await nameIt(page, 'Folder name...', 'From recent');
    await expect(listed(page, 'From recent')).toBeVisible({ timeout: 30_000 });

    // Going somewhere else closes it.
    await button.click();
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => { window.location.hash = '#/recent'; });
    await expect(menu(page)).toBeHidden();
  });

  test('on a phone it floats at the bottom and opens as a sheet', async ({ page, relayUrl }) => {
    await page.setViewportSize(PHONE);
    const owner = await startInMyDrive(page, relayUrl);
    const fab = newMenuButton(page);
    await expect(fab).toHaveAttribute('aria-label', 'New');
    await expect(page.locator('[data-testid="new-menu"]:visible')).toHaveCount(1);
    const fabBox = (await fab.boundingBox())!;
    expect(fabBox.x + fabBox.width).toBeGreaterThan(PHONE.width - 40);
    // Just above the phone's tabs.
    const tabsTop = (await page.getByTestId('drive-tabs').boundingBox())!.y;
    expect(fabBox.y + fabBox.height).toBeLessThanOrEqual(tabsTop);
    expect(fabBox.y + fabBox.height).toBeGreaterThan(tabsTop - 40);
    await shot(page, 'phone-folder');

    await fab.click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(ITEMS);
    const sheet = (await menu(page).boundingBox())!;
    expect(sheet.x).toBe(0);
    expect(Math.round(sheet.y + sheet.height)).toBe(PHONE.height);
    for (const item of await menu(page).getByRole('menuitem').all()) {
      expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    }
    await shot(page, 'phone-menu');

    // A tap beside the sheet only closes it.
    const url = page.url();
    await page.mouse.click(PHONE.width / 2, 120);
    await expect(menu(page)).toBeHidden();
    expect(page.url()).toBe(url);

    await fab.click();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(fab).toBeFocused();

    await chooseNew(page, 'Folder');
    await nameIt(page, 'Folder name...', 'Phone folder');
    await expect(listed(page, 'Phone folder')).toBeVisible({ timeout: 30_000 });
    // An upload leaves the folder open, with the file in it.
    const folderUrl = page.url();
    await uploadFilesInput(page).setInputFiles({ name: 'phone.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(listed(page, /phone\.txt/)).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(folderUrl);
    expect(folderUrl).toMatch(new RegExp(`#/${owner.profileId}/main$`));
    await shot(page, 'phone-folder-with-files');

    // Between a phone and a window with a sidebar, New sits in the folder's header.
    await page.setViewportSize({ width: 700, height: 800 });
    const headerNew = page.getByTestId('folder-header').getByRole('button', { name: 'New' });
    await expect(headerNew).toBeVisible();
    await headerNew.click();
    await expect(menu(page).getByRole('menuitem')).toHaveText(ITEMS);
    const box = (await menu(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(700);
    await shot(page, 'narrow-menu');
    await page.keyboard.press('Escape');
  });

  test('a folder only to read offers none of it', async ({ page, relayUrl }) => {
    await page.setViewportSize(DESKTOP);
    const owner = await startInMyDrive(page, relayUrl);
    await uploadFilesInput(page).setInputFiles({ name: 'shared.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(listed(page, /shared\.txt/)).toBeVisible({ timeout: 30_000 });
    await page.goto(`/#/${owner.profileId}/main`);
    await openFolderMenu(page);
    const snapshot = await page.getByTestId('permalink-link').getAttribute('href');
    await page.goto(`/${snapshot}`);
    await expect(listed(page, /shared\.txt/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="new-menu"]:visible')).toHaveCount(0);
    await page.setViewportSize(PHONE);
    await expect(page.locator('[data-testid="new-menu"]:visible')).toHaveCount(0);
  });
});
