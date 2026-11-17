import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseFileAction, chooseNew, openFileMenu } from './test-utils';

/** A 30 × 20 PNG picture made in the page, as a screenshot tool would copy it. */
async function copyScreenshot(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 30;
    canvas.height = 20;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#2c8a5c';
    context.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(png => resolve(png!), 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
}

/** A 24 × 16 PNG of solid colour. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR42mNkYPjPQAXASK0BjBoxasSoEQMBAAD8ARHfCDc5AAAAAElFTkSuQmCC',
  'base64',
);

function fileList(page: Page) {
  return page.getByTestId('file-list');
}

function row(page: Page, name: string | RegExp) {
  return fileList(page).locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function backToFolder(page: Page): Promise<void> {
  const back = page.getByTestId('viewer-back');
  if (await back.isVisible()) await back.click();
  await expect(page.getByTestId('folder-header')).toBeVisible({ timeout: 30_000 });
}

async function addFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
  await page.getByTestId('upload-files-input').setInputFiles(files);
  for (const file of files) await expect(row(page, file.name)).toBeVisible({ timeout: 30_000 });
}

/** What the clipboard holds: its kinds, and the size of a picture on it. */
function clipboardPicture(page: Page): Promise<{ types: string[]; width: number; height: number } | null> {
  return page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const types = items.flatMap(item => [...item.types]);
    const item = items.find(each => each.types.includes('image/png'));
    if (!item) return { types, width: 0, height: 0 };
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    return { types, width: bitmap.width, height: bitmap.height };
  }).catch(() => null);
}

/**
 * Drops onto an element what the desktop would hand over: entries that can be
 * walked, as Chrome gives for files and folders dragged from Finder or Explorer.
 */
async function dropTree(page: Page, target: string, tree: Record<string, unknown>, extra: Record<string, string> = {}): Promise<void> {
  await page.locator(target).first().evaluate((element, { tree, extra }) => {
    type Tree = { [name: string]: string | Tree };
    const entryOf = (name: string, value: string | Tree): unknown => {
      if (typeof value === 'string') {
        const file = new File([value], name, { type: 'text/plain' });
        return { name, isFile: true, isDirectory: false, file: (ok: (file: File) => void) => ok(file) };
      }
      let given = false;
      const children = Object.entries(value).map(([child, inner]) => entryOf(child, inner));
      return {
        name,
        isFile: false,
        isDirectory: true,
        // Like a browser, a folder hands out its children later, in a batch, then an empty batch.
        createReader: () => ({
          readEntries: (ok: (entries: unknown[]) => void) => {
            const batch = given ? [] : children;
            given = true;
            setTimeout(() => ok(batch), 0);
          },
        }),
      };
    };
    const entries = Object.entries(tree as Tree).map(([name, value]) => entryOf(name, value));
    const data = {
      items: entries.map(entry => ({ kind: 'file', type: '', webkitGetAsEntry: () => entry, getAsFile: () => null })),
      files: [],
      types: entries.length ? ['Files', ...Object.keys(extra)] : Object.keys(extra),
      getData: (type: string) => extra[type] ?? '',
      dropEffect: 'none',
    };
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: data });
      element.dispatchEvent(event);
    }
  }, { tree, extra });
}

test.describe('the system clipboard and drag and drop in a Drive folder', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a screenshot and plain text paste into the folder as files; a paste into a field stays there', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Clipboard Test');
    await expect(fileList(page)).toBeVisible({ timeout: 30_000 });

    await copyScreenshot(page);
    await fileList(page).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(row(page, /^Pasted image \d{4}-\d\d-\d\d at \d\d\.\d\d\.\d\d\.png$/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Saved as Pasted image/)).toBeVisible();
    // The folder stays open; opened, it is the picture that was pasted.
    await expect(page.getByTestId('viewer-back')).toHaveCount(0);
    await row(page, /^Pasted image /).dblclick();
    await expect(page.getByTestId('image-viewer')).toHaveJSProperty('naturalWidth', 30, { timeout: 30_000 });
    await page.screenshot({ path: test.info().outputPath('clipboard-pasted-screenshot.png') });

    await backToFolder(page);
    await page.evaluate(() => navigator.clipboard.writeText('Shopping list:\nmilk\nbread'));
    await fileList(page).focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(row(page, /^Pasted text .*\.txt$/)).toBeVisible({ timeout: 30_000 });
    await row(page, /^Pasted text .*\.txt$/).dblclick();
    await expect(page.getByText('Shopping list:')).toBeVisible({ timeout: 30_000 });

    // Pasting into the name of a new folder is pasting a name, not a file.
    await backToFolder(page);
    const before = await fileList(page).locator('a').count();
    await page.evaluate(() => navigator.clipboard.writeText('Holiday'));
    await chooseNew(page, 'Folder');
    const name = page.getByPlaceholder('Folder name...');
    await name.focus();
    await page.keyboard.press('ControlOrMeta+v');
    await expect(name).toHaveValue('Holiday');
    await page.keyboard.press('Escape');
    await expect(fileList(page).locator('a')).toHaveCount(before);
  });

  test('folders dropped from the desktop arrive with their subfolders; files dropped on a folder row go inside it', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Drop Test');
    await expect(fileList(page)).toBeVisible({ timeout: 30_000 });

    // Two folders and a loose file at once: every one of them arrives, not only the first.
    await dropTree(page, '[data-testid="file-list"]', {
      Trip: { 'plan.txt': 'Day one: walk', 'Day 2': { 'notes.txt': 'Rain' } },
      Recipes: { 'soup.txt': 'Carrots' },
      'loose.txt': 'Loose',
    });
    await expect(row(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'Recipes')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'loose.txt')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Added 2 folders')).toBeVisible();

    await row(page, 'Trip').dblclick();
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    await row(page, 'Day 2').dblclick();
    await expect(row(page, 'notes.txt')).toBeVisible({ timeout: 30_000 });

    // Dropped onto the row of a folder: into that folder, and the row shows where it goes.
    await page.goBack();
    await expect(row(page, 'Day 2')).toBeVisible({ timeout: 30_000 });
    await page.goBack();
    await expect(row(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="file-list"] a', { hasText: 'Recipes' }).evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['Flour'], 'bread.txt', { type: 'text/plain' }));
      data.items.add(new File(['Eggs'], 'cake.txt', { type: 'text/plain' }));
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await expect(page.getByText('Drop to add to Recipes')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('clipboard-drop-on-folder.png') });
    await page.locator('[data-testid="file-list"] a', { hasText: 'Recipes' }).evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['Flour'], 'bread.txt', { type: 'text/plain' }));
      data.items.add(new File(['Eggs'], 'cake.txt', { type: 'text/plain' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await expect(page.getByText('Added 2 files to Recipes')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'bread.txt')).toHaveCount(0);
    await row(page, 'Recipes').dblclick();
    await expect(row(page, 'bread.txt')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'cake.txt')).toBeVisible();
    await expect(row(page, 'soup.txt')).toBeVisible();
  });

  test('a picture dragged from a web page is saved when it can be fetched, and said when not', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Web Picture Test');
    await expect(fileList(page)).toBeVisible({ timeout: 30_000 });

    const dataUrl = `data:image/png;base64,${PICTURE.toString('base64')}`;
    await dropTree(page, '[data-testid="file-list"]', {}, { 'text/html': `<img src="${dataUrl}" alt="square">`, 'text/uri-list': dataUrl });
    await expect(row(page, /^Picture .*\.png$/)).toBeVisible({ timeout: 30_000 });

    await dropTree(page, '[data-testid="file-list"]', {}, { 'text/html': '<img src="http://127.0.0.1:9/missing.png">', 'text/uri-list': 'http://127.0.0.1:9/missing.png' });
    await expect(page.getByText('That picture could not be saved')).toBeVisible({ timeout: 30_000 });
  });

  test('a picture, a text file and any other file copy out for other apps; a file drags out as a download', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Copy Out Test');
    await expect(fileList(page)).toBeVisible({ timeout: 30_000 });
    await addFiles(page, [
      { name: 'square.png', mimeType: 'image/png', buffer: PICTURE },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember the milk') },
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not really') },
    ]);

    // Picked in the list, copied with the keys.
    await row(page, 'square.png').dblclick();
    await expect(page.getByTestId('image-viewer')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('ControlOrMeta+c');
    await expect.poll(() => clipboardPicture(page), { timeout: 15_000 }).toMatchObject({ types: ['image/png'], width: 24, height: 16 });
    await expect(page.getByText('Copied the picture square.png')).toBeVisible();

    // The open text file, copied from its ⋮ menu.
    await backToFolder(page);
    await row(page, 'notes.txt').dblclick();
    await expect(page.getByTestId('viewer-header')).toContainText('notes.txt', { timeout: 30_000 });
    await expect((await openFileMenu(page)).getByTestId('viewer-copy')).toHaveText('Copy text');
    await chooseFileAction(page, 'viewer-copy');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toBe('Remember the milk');

    // Anything else goes as a link that opens it.
    await backToFolder(page);
    await row(page, 'report.pdf').dblclick();
    await expect(page.getByTestId('viewer-header')).toContainText('report.pdf', { timeout: 30_000 });
    await expect((await openFileMenu(page)).getByTestId('viewer-copy')).toHaveText('Copy link');
    await chooseFileAction(page, 'viewer-copy');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toMatch(/#\/nhash1[a-z0-9]+\/report\.pdf$/);
    await expect(page.getByText('Copied a link to report.pdf')).toBeVisible();

    // Dragged onto the desktop: a download from this app's own address, which gives the file.
    const drag = await row(page, 'square.png').evaluate(async (element) => {
      const data = new DataTransfer();
      element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
      const value = data.getData('DownloadURL');
      element.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      const url = value.slice(value.indexOf(':', value.indexOf(':') + 1) + 1);
      const response = await fetch(url);
      return { value, url, status: response.status, size: (await response.arrayBuffer()).byteLength };
    });
    expect(drag.value).toMatch(/^application\/octet-stream:square\.png:/);
    expect(new URL(drag.url).origin).toBe(new URL(page.url()).origin);
    expect(new URL(drag.url).pathname).toMatch(/^\/htree\//);
    expect(new URL(drag.url).searchParams.get('download')).toBe('1');
    expect(drag).toMatchObject({ status: 200, size: PICTURE.length });
  });
});

test.describe('moving a cut selection', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('moves the selected files once, keeps a colliding file and supports pasting in another tab', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Cut and paste');
    const home = page.url();
    await chooseNew(page, 'Folder');
    const name = page.getByPlaceholder('Folder name...');
    await name.fill('Target');
    await name.press('Enter');
    const text = (name: string, value: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(value) });
    await addFiles(page, [text('a.txt', 'incoming'), text('b.txt', 'second')]);
    await row(page, 'Target').dblclick();
    await addFiles(page, [text('a.txt', 'original')]);
    const destUrl = page.url();
    await page.goto(home);
    await row(page, 'a.txt').click();
    await row(page, 'b.txt').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
    await page.keyboard.press('ControlOrMeta+x');
    await expect(page.getByText('Cut 2 items')).toBeVisible();
    await expect(row(page, 'a.txt')).toBeVisible();
    const target = await context.newPage();
    await target.goto(destUrl);
    await expect(row(target, 'a.txt')).toBeVisible();
    await fileList(target).focus();
    await target.keyboard.press('ControlOrMeta+v');
    await expect(row(target, 'b.txt')).toBeVisible();
    await expect(row(target, 'a (2).txt')).toBeVisible();
    await target.keyboard.press('ControlOrMeta+v');
    await expect(target.getByText('Select the items and cut them again')).toBeVisible();
    await row(target, 'a.txt').dblclick();
    await expect(target.locator('pre')).toContainText('original');
    await target.close();
    await page.reload();
    await expect(row(page, 'Target')).toBeVisible();
    await expect(row(page, 'b.txt')).toHaveCount(0);
    await expect(row(page, 'a.txt')).toHaveCount(0);
  });
});
