import { expect, test, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

/** A small picture with something in it: a 24×16 PNG of solid colour. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR42mNkYPjPQAXASK0BjBoxasSoEQMBAAD8ARHfCDc5AAAAAElFTkSuQmCC',
  'base64',
);

/**
 * Waits as long as a person takes between moving the cursor and the next key.
 * The browser tells the editor where the cursor went a frame after it moved.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(200);
}

/** What the document holds, block by block: the tag and the start of its text. */
function blocks(page: Page): Promise<string[]> {
  return documentBody(page).evaluate(root => [...root.children].map(node => `${node.tagName.toLowerCase()}:${(node.textContent ?? '').trim()}`));
}

/** Drops a picture file onto the middle of a block of the document, as from the desktop. */
async function dropPicture(page: Page, onText: string): Promise<void> {
  await documentBody(page).evaluate((root, [text, base64]) => {
    const target = [...root.children].find(node => node.textContent?.includes(text))!;
    const box = target.getBoundingClientRect();
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    const init = { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.right - 2, clientY: box.top + box.height / 2 };
    target.dispatchEvent(new DragEvent('dragenter', init));
    target.dispatchEvent(new DragEvent('dragover', init));
    target.dispatchEvent(new DragEvent('drop', init));
  }, [onText, PICTURE.toString('base64')] as const);
}

test.describe('writing a document', () => {
  test.setTimeout(180_000);

  test('a picture stays when typing goes on after it, and a dropped one lands where it is dropped', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Pictures');
    await typeInDocument(page, 'Before the picture');
    await page.keyboard.press('Enter');
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({ name: 'square.png', mimeType: 'image/png', buffer: PICTURE });
    await expect(documentBody(page).locator('img')).toHaveCount(1);
    // Typing straight on writes below the picture instead of replacing it.
    await page.keyboard.type('A caption');
    await expect(documentBody(page).locator('img')).toHaveCount(1);
    expect(await blocks(page)).toEqual(['p:Before the picture', 'img:', 'p:A caption']);

    // A picture dropped onto the first line goes there, not where the cursor was.
    await dropPicture(page, 'Before the picture');
    await expect(documentBody(page).locator('img')).toHaveCount(2);
    expect(await blocks(page)).toEqual(['p:Before the picture', 'img:', 'p:', 'img:', 'p:A caption']);
    await page.keyboard.type('Second caption');
    expect(await blocks(page)).toEqual(['p:Before the picture', 'img:', 'p:Second caption', 'img:', 'p:A caption']);
    await expectSaved(page);
  });

  test('words become a link from the toolbar or with the keyboard, and a link opens, changes and goes away from its bubble', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Links');
    await typeInDocument(page, 'Read the map first');
    // Select "map" with the keyboard, then press the shortcut other editors use.
    for (let index = 0; index < ' first'.length; index += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.down('Shift');
    for (let index = 0; index < 'map'.length; index += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await settle(page);
    await page.keyboard.press('ControlOrMeta+k');
    const field = page.getByTestId('document-link-input');
    await expect(field).toBeFocused();
    await field.fill('example.com/map');
    await field.press('Enter');
    const link = documentBody(page).locator('a');
    await expect(link).toHaveText('map');
    await expect(link).toHaveAttribute('href', 'https://example.com/map');
    // The text goes on where it was, not inside the field: after the link,
    // neither replacing the linked words nor joining the link.
    await expect(documentBody(page)).toBeFocused();
    await page.keyboard.type('s');
    await expect(documentBody(page)).toContainText('Read the maps first');
    await expect(link).toHaveText('map');
    await page.keyboard.press('Backspace');

    // Clicking a link while writing puts the cursor in it and shows where it goes; it does not leave the page.
    let opened = 0;
    context.on('page', () => { opened += 1; });
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+End');
    await link.click();
    const bubble = page.getByTestId('document-link-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble.getByRole('link')).toHaveAttribute('href', 'https://example.com/map');
    await expect(bubble.getByRole('link')).toHaveAttribute('target', '_blank');
    expect(opened).toBe(0);

    // Changing it from the bubble.
    await bubble.getByRole('button', { name: 'Change link' }).click();
    await expect(field).toHaveValue('https://example.com/map');
    await field.fill('https://example.org/');
    await field.press('Enter');
    await expect(link).toHaveAttribute('href', 'https://example.org/');
    await expect(link).toHaveText('map');

    // Removing it leaves the words.
    await link.click();
    await page.getByTestId('document-link-bubble').getByRole('button', { name: 'Remove link' }).click();
    await expect(documentBody(page).locator('a')).toHaveCount(0);
    await expect(documentBody(page)).toContainText('Read the map first');

    // The toolbar button with nothing selected adds the address itself as a link.
    await documentBody(page).locator('p').last().click({ position: { x: 600, y: 10 } });
    await settle(page);
    await page.keyboard.type(' ');
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await field.fill('https://iris.to');
    await field.press('Enter');
    await expect(documentBody(page).locator('a')).toHaveText('https://iris.to');
    // What is typed next is not part of the link.
    await page.keyboard.type(' done');
    await expect(documentBody(page)).toContainText('https://iris.to done');
    await expect(documentBody(page).locator('a')).toHaveText('https://iris.to');
    await expectSaved(page);
  });

  test('printing prints the page alone, from the toolbar and from the browser', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Printed');
    await typeInDocument(page, 'Only these words go to paper');
    // The browser's print window cannot be driven here; what it would print is what the page shows for print.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
        window.dispatchEvent(new Event('beforeprint'));
      };
    });
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByText('Only these words go to paper').filter({ visible: true })).toHaveCount(1);
    await expect(page.getByTestId('document-toolbar')).toBeHidden();
    await expect(page.getByTestId('document-title')).toBeHidden();
    await expect(page.getByTestId('drive-sidebar')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    await expect(page.getByTestId('document-toolbar')).toBeVisible();
    await expect(page.getByText('Only these words go to paper')).toHaveCount(1);
  });

  test('a table is added, filled with Tab, kept after a reload, and changed from its menu', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Plan');
    await typeInDocument(page, 'The week');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    const table = documentBody(page).locator('table');
    await expect(table.locator('tr')).toHaveCount(3);
    await expect(table.locator('tr').first().locator('td, th')).toHaveCount(3);
    // Tab goes from cell to cell, and on from the last one into a new row.
    const rows = [['Day', 'Place', 'Notes'], ['Mon', 'Coast', 'Swim'], ['Tue', 'Hills', 'Walk'], ['Wed', 'Home', 'Rest']];
    for (const [index, row] of rows.entries()) {
      for (const [column, text] of row.entries()) {
        await page.keyboard.type(text);
        if (index < rows.length - 1 || column < row.length - 1) await page.keyboard.press('Tab');
      }
    }
    await expect(table.locator('tr')).toHaveCount(4);
    await expectSaved(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(table.locator('tr')).toHaveCount(4, { timeout: 60_000 });
    await expect(table.locator('tr').nth(2)).toHaveText('TueHillsWalk');

    // With the cursor in a table, the same button offers what changes it.
    await table.getByText('Hills').click();
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete column' }).click();
    await expect(table.locator('tr').first()).toHaveText('DayNotes');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Insert row below' }).click();
    await expect(table.locator('tr')).toHaveCount(5);
    await expect(table.locator('tr').nth(3)).toHaveText('');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete table' }).click();
    await expect(documentBody(page).locator('table')).toHaveCount(0);
    await expect(documentBody(page)).toContainText('The week');
    await expectSaved(page);
  });

  test('the header says when the network is gone, and what was written meanwhile is kept', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Away');
    await typeInDocument(page, 'Written online.');
    await expectSaved(page);
    const status = page.getByTestId('document-save-status');
    await expect(status).not.toContainText('Offline');

    await context.setOffline(true);
    await expect(status).toContainText('Offline');
    await typeInDocument(page, ' Written offline.');
    await expectSaved(page);
    await expect(status).toContainText('Offline');

    await context.setOffline(false);
    await expect(status).not.toContainText('Offline');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Written online. Written offline.', { timeout: 60_000 });
  });
});
