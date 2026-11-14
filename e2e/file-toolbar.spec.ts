// A file's page keeps Download and Share in sight and the rest behind ⋮, in
// plain words, and its toolbar is one row on a phone.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable, openListedFile, uploadIntoFolder } from './test-utils';

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function visibleButtons(page: Page) {
  return page.getByTestId('viewer-header').locator('button:visible, a:visible');
}

test('a file page shows Download, Share and ⋮, in one row on a phone', async ({ page, relayUrl }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DESKTOP);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Toolbar');
  await expectFolderEditable(page);
  await uploadIntoFolder(page, [
    { name: 'a long name for the trip packing list.txt', mimeType: 'text/plain', buffer: Buffer.from('Boots') },
    { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('Tent') },
  ]);
  await openListedFile(page, 'a long name for the trip packing list.txt');

  const header = page.getByTestId('viewer-header');
  await expect(header.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Share' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'More actions' })).toBeVisible();
  // Back, Download, Share and ⋮: nothing else, and no jargon.
  expect(await (await visibleButtons(page)).count()).toBe(4);
  await expect(header).not.toContainText('Snapshot');
  await expect(header).not.toContainText('Push');

  await header.getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Copy text', 'Read-only copy', 'Full screen', 'Save to file servers', 'Rename', 'Move', 'Delete']);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('file-menu-desktop.png') });
  const fileUrl = page.url();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // Escape closed the menu; the file stays open.
  expect(page.url()).toBe(fileUrl);

  // A phone: still one row, the name shortened rather than the buttons wrapped.
  await page.setViewportSize(PHONE);
  await expect(header.getByRole('button', { name: 'Download' })).toBeVisible();
  const headerBox = (await header.boundingBox())!;
  expect(headerBox.height).toBeLessThan(60);
  const tops = new Set<number>();
  for (const control of await (await visibleButtons(page)).all()) {
    const box = (await control.boundingBox())!;
    tops.add(Math.round(box.y + box.height / 2));
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
  }
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath('file-page-phone.png') });

  // On a phone ⋮ rises from the bottom, and its actions work from there.
  await header.getByRole('button', { name: 'More actions' }).click();
  const sheet = (await menu.boundingBox())!;
  expect(sheet.x).toBe(0);
  expect(Math.round(sheet.y + sheet.height)).toBe(PHONE.height);
  // The next and previous files are here on a phone, so the name keeps its room above.
  await expect(menu.getByRole('menuitem').first()).toHaveText('Next file');
  await page.screenshot({ path: testInfo.outputPath('file-menu-phone.png') });
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByPlaceholder('New name...').fill('packing.txt');
  await page.getByPlaceholder('New name...').press('Enter');
  await expect(header).toContainText('packing.txt', { timeout: 30_000 });
});
