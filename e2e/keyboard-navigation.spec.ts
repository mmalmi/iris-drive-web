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
