// Changes made one right after another all stay: each builds on the one
// before instead of on the folder as it was when it started.
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew, expectFolderEditable, fileRow } from './test-utils';

const text = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });

test.describe('quick changes', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Quick Changes');
    await expectFolderEditable(page);
  });

  test('a folder made just before an upload stays', async ({ page }) => {
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Team');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await page.getByTestId('upload-files-input').setInputFiles([text('budget.txt')]);

    await expect(fileRow(page, 'budget.txt')).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'Team')).toBeVisible();
    await page.reload();
    await expect(fileRow(page, 'budget.txt')).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'Team')).toBeVisible();
  });

  test('a second upload waits for the first instead of stopping it', async ({ page }) => {
    const input = page.getByTestId('upload-files-input');
    await input.setInputFiles([text('first.txt'), text('second.txt')]);
    await input.setInputFiles([text('third.txt')]);

    for (const name of ['first.txt', 'second.txt', 'third.txt']) {
      await expect(fileRow(page, name)).toBeVisible({ timeout: 30_000 });
    }
    await page.reload();
    for (const name of ['first.txt', 'second.txt', 'third.txt']) {
      await expect(fileRow(page, name)).toBeVisible({ timeout: 30_000 });
    }
  });
});
