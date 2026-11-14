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
  // The whole row is marked, its ⋮ button too.
  await expect(list.getByTestId('file-row').filter({ has: page.getByRole('link', { name: 'Inner', exact: true }) })).toHaveClass(/ring-accent/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/main\/Keys\/Inner$/);
  await expect(page.getByTestId('empty-folder')).toBeVisible();
});

test('Delete on the ".." row beside an open file deletes nothing', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Keys Test');
  await createAndEnterFolder(page, 'Keys');
  await createTextFile(page, 'alpha.txt', 'Alpha');

  const list = page.getByTestId('file-list');
  await list.getByRole('link', { name: /^alpha\.txt/ }).click();
  await expect(page.locator('pre')).toContainText('Alpha', { timeout: 30_000 });
  const prompts: string[] = [];
  page.on('dialog', (dialog) => {
    prompts.push(dialog.message());
    void dialog.dismiss();
  });

  // Up past the file to the rows above it, the top one being "..".
  await list.focus();
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  expect(prompts).toEqual([]);
  await expect(list.getByRole('link', { name: /^alpha\.txt/ })).toBeVisible();
});
