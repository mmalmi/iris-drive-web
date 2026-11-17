import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseFileAction, chooseNew, openFolderMenu, openListedFile } from './test-utils';

function row(page: Page, name: string) {
  return page.getByTestId('file-list').locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function makeFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await expect(row(page, name)).toBeVisible({ timeout: 30_000 });
}

async function openFolder(page: Page, name: string): Promise<void> {
  await row(page, name).dblclick();
  await expect(page).toHaveURL(new RegExp(`/${name}$`), { timeout: 30_000 });
  await expect(row(page, name)).toHaveCount(0, { timeout: 30_000 });
}

test.describe('moving files and folders', () => {
  test.setTimeout(120_000);

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('a file is moved into a folder two levels down from its own page', async ({ page, relayUrl }) => {
      await prepareFreshSession(page, relayUrl);
      await createDriveProfile(page, 'Mover');
      await makeFolder(page, 'Inbox');
      await makeFolder(page, 'Archive');
      await openFolder(page, 'Archive');
      await makeFolder(page, '2025');
      await page.getByRole('link', { name: 'Back' }).click();
      await expect(row(page, 'Inbox')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Plant the beans') });
      await openListedFile(page, 'plan.txt');
      await expect(page.getByText('Plant the beans')).toBeVisible({ timeout: 30_000 });

      await chooseFileAction(page, 'viewer-move');
      const dialog = page.getByTestId('move-dialog');
      await expect(dialog.getByTestId('move-here-name')).toHaveText('My Drive');
      // Where it already is cannot be chosen.
      await expect(dialog.getByTestId('move-confirm')).toBeDisabled();
      await expect(dialog.getByTestId('move-folder')).toHaveText(['Archive', 'Inbox']);
      await dialog.getByTestId('move-folder').filter({ hasText: 'Archive' }).click();
      await dialog.getByTestId('move-folder').filter({ hasText: '2025' }).click();
      await expect(dialog.getByTestId('move-here-name')).toHaveText('2025');
      await page.screenshot({ path: test.info().outputPath('move-dialog-phone.png') });
      await dialog.getByTestId('move-confirm').click();

      await expect(page.getByText('Moved plan.txt to 2025')).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(/\/main\/Archive\/2025\/plan\.txt$/, { timeout: 30_000 });
      await expect(page.getByText('Plant the beans')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('viewer-back').click();
      await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
      await page.getByRole('link', { name: 'Back' }).click();
      await page.getByRole('link', { name: 'Back' }).click();
      await expect(row(page, 'Inbox')).toBeVisible({ timeout: 30_000 });
      await expect(row(page, 'plan.txt')).toHaveCount(0);
    });
  });

  test('a folder is moved from its menu, and cannot be moved into itself', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Mover');
    await makeFolder(page, 'Archive');
    await openFolder(page, 'Archive');
    await makeFolder(page, 'Inbox');
    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My Drive' }).click();
    await expect(row(page, 'Archive')).toBeVisible();
    await makeFolder(page, 'Inbox');
    await openFolder(page, 'Inbox');
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Inside') });
    await expect(row(page, 'note.txt')).toBeVisible({ timeout: 30_000 });

    await openFolderMenu(page);
    await page.getByTestId('move-folder-btn').click();
    const dialog = page.getByTestId('move-dialog');
    await expect(dialog.getByTestId('move-folder')).toHaveText(['Archive']);
    await dialog.getByTestId('move-folder').click();
    await dialog.getByTestId('move-confirm').click();

    await expect(page).toHaveURL(/\/main\/Archive\/Inbox(?:%20| )\(2\)$/, { timeout: 30_000 });
    await expect(row(page, 'note.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('a dragged file gets a free name when its destination already contains that name', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Mover');
    await makeFolder(page, 'Archive');
    const upload = async () => {
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Plant the beans') });
      await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    };
    const archive = page.locator('[data-testid="file-row"][data-entry-name="Archive"]');

    await upload();
    await row(page, 'plan.txt').dragTo(archive);
    await expect(page.getByText('Moved plan.txt to Archive')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'plan.txt')).toHaveCount(0, { timeout: 30_000 });

    await upload();
    await row(page, 'plan.txt').dragTo(archive);
    await expect(page.getByText('Moved plan.txt to Archive · “plan.txt” is now “plan (2).txt”')).toBeVisible();
    await expect(row(page, 'plan.txt')).toHaveCount(0);
    await openFolder(page, 'Archive');
    await expect(row(page, 'plan.txt')).toBeVisible();
    await expect(row(page, 'plan (2).txt')).toBeVisible();
  });

  for (const gesture of ['drag', 'dialog'] as const) {
    test(`a replacement during a ${gesture} leaves the entire selection in its source folder`, async ({ page, relayUrl }) => {
      await prepareFreshSession(page, relayUrl);
      await createDriveProfile(page, 'Mover');
      await makeFolder(page, 'Archive');
      const upload = page.getByTestId('upload-files-input');
      const file = (name: string, content: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
      await upload.setInputFiles([file('a.txt', 'first'), file('b.txt', 'second')]);
      for (const name of ['a.txt', 'b.txt']) {
        await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
      }

      const transfer = await page.evaluateHandle(() => new DataTransfer());
      const dialog = page.getByTestId('move-dialog');
      if (gesture === 'drag') await row(page, 'a.txt').dispatchEvent('dragstart', { dataTransfer: transfer });
      else {
        await page.getByTestId('selection-move').click();
        await dialog.getByTestId('move-folder').filter({ hasText: 'Archive' }).click();
      }
      // A replacement arrives after selection but before the drop or confirmation.
      await upload.setInputFiles(file('b.txt', 'replacement contents'));
      await expect(page.locator('[data-testid="file-row"][data-entry-name="b.txt"]')).toContainText('20 B');
      if (gesture === 'drag') {
        await page.locator('[data-testid="file-row"][data-entry-name="Archive"]').dispatchEvent('drop', { dataTransfer: transfer });
      } else await dialog.getByTestId('move-confirm').click();
      await expect(page.getByRole('alert')).toContainText('“b.txt” changed. Select it again to move it.');
      if (gesture === 'dialog') await dialog.getByRole('button', { name: 'Cancel' }).click();
      for (const name of ['a.txt', 'b.txt']) await expect(row(page, name)).toBeVisible();
      await openFolder(page, 'Archive');
      await expect(page.getByTestId('empty-folder')).toBeVisible();
    });
  }

  test('a dragged selection moves together and keeps both versions of a conflicting file', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Mover');
    await makeFolder(page, 'Archive');
    const names = ['a.txt', 'b.txt', 'c.txt'];
    await page.getByTestId('upload-files-input').setInputFiles(names.map(name => ({
      name, mimeType: 'text/plain', buffer: Buffer.from('original contents of ' + name),
    })));
    for (const name of names) await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
    const archive = page.locator('[data-testid="file-row"][data-entry-name="Archive"]');
    await row(page, 'b.txt').dragTo(archive);
    await expect(page.getByText('Moved 3 items to Archive')).toBeVisible();
    for (const name of names) await expect(row(page, name)).toHaveCount(0);
    await expect(page.getByTestId('selection-bar')).toBeHidden();
    await openFolder(page, 'Archive');
    for (const name of names) await expect(row(page, name)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('bulk-move-destination.png') });
    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'My Drive' }).click();
    await expect(archive).toBeVisible();

    const incoming = ['0-free.txt', 'b.txt'];
    await page.getByTestId('upload-files-input').setInputFiles(incoming.map(name => ({
      name, mimeType: 'text/plain', buffer: Buffer.from('new contents'),
    })));
    for (const name of incoming) await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
    await row(page, '0-free.txt').dragTo(archive);
    await expect(page.getByText('Moved 2 items to Archive · “b.txt” is now “b (2).txt”')).toBeVisible();
    for (const name of incoming) await expect(row(page, name)).toHaveCount(0);
    const notice = page.getByRole('status').filter({ hasText: 'Moved 2 items to Archive' });
    await page.screenshot({ path: test.info().outputPath('move-confirmation.png') });
    await notice.getByRole('button', { name: 'Go to folder' }).click();
    await expect(page).toHaveURL(/\/main\/Archive$/);
    await page.reload();
    for (const name of [...names, '0-free.txt', 'b (2).txt']) await expect(row(page, name)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('bulk-move-conflict.png') });
    await openListedFile(page, 'b (2).txt');
    await expect(page.getByText('new contents', { exact: true })).toBeVisible();
    await page.getByTestId('viewer-back').click();
    await openListedFile(page, 'b.txt');
    await expect(page.getByText('original contents of b.txt', { exact: true })).toBeVisible();
  });
});
