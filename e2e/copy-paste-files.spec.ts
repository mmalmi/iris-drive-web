import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew } from './test-utils';

/** A 24 × 16 PNG of solid colour. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR42mNkYPjPQAXASK0BjBoxasSoEQMBAAD8ARHfCDc5AAAAAElFTkSuQmCC',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4 a report that is not really a PDF');

function fileList(page: Page) {
  return page.getByTestId('file-list');
}

function row(page: Page, name: string | RegExp) {
  return fileList(page).locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function copy(page: Page, name: string, said: string): Promise<void> {
  await row(page, name).click();
  await expect(page.getByTestId('viewer-header')).toContainText(name, { timeout: 30_000 });
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByText(said).last()).toBeVisible({ timeout: 15_000 });
}

async function pasteInto(page: Page, folder: string): Promise<void> {
  await row(page, folder).click();
  await expect(page).toHaveURL(new RegExp(`/${folder}$`), { timeout: 30_000 });
  // The folder is open once the list no longer shows the one it is in.
  await expect(row(page, folder)).toHaveCount(0, { timeout: 30_000 });
  await fileList(page).focus();
  await page.keyboard.press('ControlOrMeta+v');
}

test.describe('copying files between folders', () => {
  test.setTimeout(180_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a file copied in Drive pastes into another folder as itself, with its name and content', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Copy Paste Test');
    await expect(fileList(page)).toBeVisible({ timeout: 30_000 });
    const home = page.url();
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Archive');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await expect(row(page, 'Archive')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('upload-files-input').setInputFiles([
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: PDF },
      { name: 'square.png', mimeType: 'image/png', buffer: PICTURE },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember the milk') },
    ]);
    for (const name of ['report.pdf', 'square.png', 'notes.txt']) await expect(row(page, name)).toBeVisible({ timeout: 30_000 });

    // A file that copies out as a link comes back as the file, not as a text file holding the link.
    await copy(page, 'report.pdf', 'Copied a link to report.pdf');
    await pasteInto(page, 'Archive');
    await expect(row(page, 'report.pdf')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'report.pdf')).toContainText(`${PDF.length} B`);
    await expect(row(page, /^Pasted /)).toHaveCount(0);

    // A picture keeps its own name and bytes rather than becoming a new PNG.
    await page.goto(home);
    await copy(page, 'square.png', 'Copied the picture square.png');
    await pasteInto(page, 'Archive');
    await expect(row(page, 'square.png')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'square.png')).toContainText(`${PICTURE.length} B`);

    // So does a text file; pasting it again beside itself gives a second name.
    await page.goto(home);
    await copy(page, 'notes.txt', 'Copied the text of notes.txt');
    await pasteInto(page, 'Archive');
    await expect(row(page, 'notes.txt')).toBeVisible({ timeout: 30_000 });
    await fileList(page).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(row(page, 'notes (2).txt')).toBeVisible({ timeout: 30_000 });
    await row(page, 'notes (2).txt').click();
    await expect(page.getByText('Remember the milk')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, /^Pasted /)).toHaveCount(0);

    // Text copied anywhere else still pastes as a new text file.
    await page.evaluate(() => navigator.clipboard.writeText('Something else'));
    await fileList(page).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(row(page, /^Pasted text .*\.txt$/)).toBeVisible({ timeout: 30_000 });
  });
});
