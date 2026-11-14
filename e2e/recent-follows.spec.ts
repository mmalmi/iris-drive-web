import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseFileAction } from './test-utils';

function row(page: Page, name: string) {
  return page.getByTestId('file-list').locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function openFile(page: Page, name: string): Promise<void> {
  await row(page, name).click();
  await expect(page.getByTestId('viewer-header')).toContainText(name, { timeout: 30_000 });
}

test.describe('Recent', () => {
  test.setTimeout(120_000);

  test('follows a file that is renamed and forgets one that is deleted', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Recent Test');
    await page.getByTestId('upload-files-input').setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Buy bread') },
      { name: 'old.txt', mimeType: 'text/plain', buffer: Buffer.from('Out of date') },
    ]);
    await expect(row(page, 'old.txt')).toBeVisible({ timeout: 30_000 });
    await openFile(page, 'notes.txt');
    await openFile(page, 'old.txt');

    page.once('dialog', dialog => void dialog.accept());
    await chooseFileAction(page, 'viewer-delete');
    await expect(row(page, 'old.txt')).toHaveCount(0, { timeout: 30_000 });

    await openFile(page, 'notes.txt');
    await chooseFileAction(page, 'viewer-rename');
    await page.getByPlaceholder('New name...').fill('shopping.txt');
    await page.getByPlaceholder('New name...').press('Enter');
    await expect(row(page, 'shopping.txt')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: 'Recent' }).first().click();
    const recent = page.getByTestId('recents-view');
    await expect(recent.getByRole('link', { name: /shopping\.txt/ })).toBeVisible({ timeout: 30_000 });
    await expect(recent.getByRole('link', { name: /notes\.txt/ })).toHaveCount(0);
    await expect(recent.getByRole('link', { name: /old\.txt/ })).toHaveCount(0);

    await recent.getByRole('link', { name: /shopping\.txt/ }).click();
    await expect(page.getByText('Buy bread')).toBeVisible({ timeout: 30_000 });
  });
});
