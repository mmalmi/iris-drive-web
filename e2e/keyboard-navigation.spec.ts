import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createFolder, createTextFile, fileRow } from './test-utils';

test('arrows and j/k move through a folder without opening anything; Enter opens, Escape closes', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Keys Test');
  await createAndEnterFolder(page, 'Keys');
  await createFolder(page, 'Inner');
  await createTextFile(page, 'alpha.txt', 'Alpha');
  await createTextFile(page, 'beta.txt', 'Beta');

  const list = page.getByTestId('file-list');
  const chosen = (name: string) => expect(fileRow(page, name).getByRole('checkbox')).toBeChecked();
  const shown = page.locator('pre');
  const folderUrl = page.url();

  // The list is on the file just closed, its last row: it ends there.
  await expect(list).toBeFocused();
  await chosen('beta.txt');
  await page.keyboard.press('ArrowDown');
  await chosen('beta.txt');
  await page.keyboard.press('k');
  await chosen('alpha.txt');
  await page.keyboard.press('ArrowUp');
  await chosen('Inner');
  await page.keyboard.press('j');
  await chosen('alpha.txt');
  expect(page.url()).toBe(folderUrl);
  await expect(shown).toHaveCount(0);

  // Enter opens the file in the folder's place; left and right step through the files.
  await page.keyboard.press('Enter');
  await expect(shown).toContainText('Alpha', { timeout: 30_000 });
  await expect(list).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect(shown).toContainText('Beta');
  await page.getByTestId('viewer-previous').click();
  await expect(shown).toContainText('Alpha');

  // A finger's quick flick sideways steps too, as on a phone; a slow drag or a vertical one does not.
  const flick = (dx: number, dy = 0, ms = 80) => shown.evaluate(async (node, { dx, dy, ms }) => {
    const box = node.getBoundingClientRect();
    const touch = (x: number, y: number) => new Touch({ identifier: 1, target: node, clientX: x, clientY: y });
    const x = box.left + 200, y = box.top + 10;
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(x, y)], changedTouches: [touch(x, y)] }));
    await new Promise((done) => setTimeout(done, ms));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [touch(x + dx, y + dy)] }));
  }, { dx, dy, ms });
  await flick(-120);
  await expect(shown).toContainText('Beta');
  await flick(-120, 200);
  await flick(-120, 0, 900);
  await flick(120);
  await expect(shown).toContainText('Alpha');

  // Escape closes it, back on that file in the list.
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(folderUrl);
  await expect(list).toBeFocused();
  await chosen('alpha.txt');

  await page.keyboard.press('ArrowUp');
  await chosen('Inner');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/main\/Keys\/Inner$/);
  await expect(page.getByTestId('empty-folder')).toBeVisible();
});

test('search, help, rename and open in a new tab from the keyboard', async ({ page, context, relayUrl }, testInfo) => {
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'File keys');
  await createAndEnterFolder(page, 'Projects');
  await createFolder(page, 'Reports');
  const list = page.getByTestId('file-list');
  await list.focus();
  await expect(fileRow(page, 'Reports')).toBeVisible();
  await expect(page.getByPlaceholder('Folder name...')).toBeHidden();
  await list.focus();
  await page.keyboard.press('/');
  const search = page.getByRole('textbox', { name: 'Search Drive' });
  await expect(search).toBeFocused();
  await search.press('/');
  await expect(search).toHaveValue('/');
  await search.press('Escape');

  await list.focus();
  await page.keyboard.press('ControlOrMeta+/');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toContainText('Open in new tab');
  await page.screenshot({ path: testInfo.outputPath('keyboard-shortcuts.png') });
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(list).toBeFocused();

  await fileRow(page, 'Reports').getByRole('link').click();
  await page.keyboard.press('F2');
  const rename = page.getByPlaceholder('New name...');
  await expect(rename).toHaveValue('Reports');
  await rename.fill('Invoices');
  await rename.press('Enter');
  await expect(fileRow(page, 'Invoices')).toBeVisible();
  await fileRow(page, 'Invoices').getByRole('link').click();
  const original = page.url();
  const opened = context.waitForEvent('page');
  await page.keyboard.press('ControlOrMeta+Enter');
  const tab = await opened;
  await expect(tab).toHaveURL(/\/Projects\/Invoices$/);
  await expect(tab.getByTestId('folder-header')).toContainText('Invoices');
  expect(page.url()).toBe(original);
  await tab.close();
});

test.describe('keyboard actions for selected files', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
  test('copies existing links, opens Share, and moves a selection', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Keyboard sharing');
    await createAndEnterFolder(page, 'Projects');
    await createFolder(page, 'Invoices');
    await createFolder(page, 'Receipts');
    await createFolder(page, 'Archive');
    const invoices = fileRow(page, 'Invoices').getByRole('link');
    const receipts = fileRow(page, 'Receipts').getByRole('link');
    const invoiceUrl = new URL((await invoices.getAttribute('href'))!, page.url()).href;
    const receiptUrl = new URL((await receipts.getAttribute('href'))!, page.url()).href;
    await invoices.click();
    await page.keyboard.press('ControlOrMeta+Alt+l');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(invoiceUrl);
    await page.keyboard.press('ControlOrMeta+Alt+a');
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toBeHidden();

    await invoices.click();
    await receipts.click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
    await page.keyboard.press('ControlOrMeta+Alt+l');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([invoiceUrl, receiptUrl].join('\n'));
    await page.keyboard.press('ControlOrMeta+Alt+m');
    const move = page.getByTestId('move-dialog');
    await expect(move).toBeVisible();
    await move.getByRole('button', { name: 'Archive' }).click();
    await move.getByRole('button', { name: 'Move here' }).click();
    await expect(invoices).toHaveCount(0);
    await fileRow(page, 'Archive').getByRole('link').dblclick();
    await expect(invoices).toBeVisible();
    await expect(receipts).toBeVisible();
  });
});
