import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createFolder, createTextFile } from './test-utils';

test('the arrow keys and j/k step through a folder, and Enter opens a folder', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Keys Test');
  await createAndEnterFolder(page, 'Keys');
  await createFolder(page, 'Inner');
  await createTextFile(page, 'alpha.txt', 'Alpha');
  await createTextFile(page, 'beta.txt', 'Beta');

  const list = page.getByTestId('file-list');
  const shown = page.locator('pre');
  await list.getByRole('link', { name: /^alpha\.txt/ }).click();
  await expect(shown).toContainText('Alpha', { timeout: 30_000 });

  await list.focus();
  await page.keyboard.press('ArrowDown');
  await expect(shown).toContainText('Beta');
  await page.keyboard.press('k');
  await expect(shown).toContainText('Alpha');
  await page.keyboard.press('j');
  await expect(shown).toContainText('Beta');

  // Moving onto a folder only marks it; Enter opens it.
  await page.keyboard.press('ArrowUp');
  await expect(shown).toContainText('Alpha');
  await page.keyboard.press('ArrowUp');
  const inner = list.getByRole('link', { name: 'Inner', exact: true });
  await expect(inner).toHaveClass(/ring-accent/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/main\/Keys\/Inner$/);
  await expect(page.getByTestId('empty-folder')).toBeVisible();
});
