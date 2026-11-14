import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { clickSlide, createPresentation, elements, settle, sheet, shot, thumbs, typeInBox } from './slides.helpers';

/**
 * Habits people bring from Google Slides: links in the text that open while
 * presenting, a table copied from a spreadsheet that stays a table, and a
 * slide number typed while presenting to go to it.
 */
test.describe('what people used to Google Slides reach for', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 800 } });

  test('addresses become links, Ctrl+K links chosen words, and links open while presenting and stay in PowerPoint', async ({ page, context, relayUrl }) => {
    // Nothing leaves the machine: the addresses answer here.
    await context.route(/^https:\/\/example\.com\//, route => route.fulfill({ contentType: 'text/html', body: '<title>Opened</title>Opened' }));
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Links');
    await typeInBox(page, 0, 'Sources');
    await page.keyboard.press('Escape');

    // An address typed out becomes a link once a space follows it.
    await typeInBox(page, 1, 'The plan is at https://example.com/plan and the notes too');
    const text = sheet(page).locator('.ProseMirror');
    await expect(text.locator('a[href="https://example.com/plan"]')).toHaveText('https://example.com/plan');

    // Ctrl+K on chosen words asks where they go. They are chosen with the
    // keyboard: two quick clicks under a loaded machine can reach the editor
    // as a double click, which a person's hand does not produce.
    for (let step = 0; step < ' too'.length; step += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.down('Shift');
    for (let step = 0; step < 'notes'.length; step += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    // The editor learns where the selection went a little after the click; a person sees it before reaching for the keys.
    await expect.poll(() => text.evaluate((root) => {
      const { state } = (root as HTMLElement & { editor: { state: { selection: { from: number; to: number }; doc: { textBetween: (from: number, to: number) => string } } } }).editor;
      return state.doc.textBetween(state.selection.from, state.selection.to);
    })).toBe('notes');
    await page.keyboard.press('ControlOrMeta+k');
    const field = page.getByTestId('document-link-editor').locator('input');
    await expect(field).toBeFocused();
    await field.fill('example.com/notes');
    await field.press('Enter');
    await expect(text.locator('a[href="https://example.com/notes"]')).toHaveText('notes');
    await expect(text).toBeFocused();
    // With the cursor in a link, a bubble shows where it goes: moved there by key or by a click.
    // A person's pause first: the editor checks the cursor a moment after it gets the focus back.
    const bubble = page.getByTestId('document-link-bubble');
    await settle(page);
    await page.keyboard.press('ArrowLeft');
    await expect(bubble).toContainText('example.com/notes');
    const plan = (await text.locator('a[href="https://example.com/plan"]').boundingBox())!;
    await page.mouse.click(plan.x + plan.width / 2, plan.y + plan.height / 2);
    await expect(bubble).toContainText('example.com/plan');
    await shot(page, 'habits-01-link-bubble');
    await page.keyboard.press('Escape');
    await expect(bubble).toHaveCount(0);

    // On the slide being edited a link reads as one, and a click selects its box rather than leaving.
    const box = elements(page, 'text').nth(1);
    const drawn = box.locator('a[href="https://example.com/plan"]');
    await expect(drawn).toHaveText('https://example.com/plan');
    await expect(thumbs(page).first().locator('a[href="https://example.com/notes"]')).toHaveText('notes');
    const linkBox = (await drawn.boundingBox())!;
    await page.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
    await page.waitForTimeout(500);
    expect(context.pages()).toHaveLength(1);

    // While presenting, a click on the link opens it and keeps the slide.
    await clickSlide(page, 640, 700);
    await page.getByTestId('present').click();
    const present = page.getByTestId('present-view');
    await expect(present).toHaveAttribute('data-slide-index', '0');
    const shown = present.locator('a[href="https://example.com/plan"]');
    const [opened] = await Promise.all([context.waitForEvent('page'), shown.click()]);
    await opened.waitForLoadState();
    expect(opened.url()).toBe('https://example.com/plan');
    await opened.close();
    await expect(present).toHaveAttribute('data-slide-index', '0');
    await page.keyboard.press('Escape');

    // PowerPoint gets the links too.
    await page.getByTestId('slides-more').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('slides-pptx-button').click()]);
    const files = unzipSync(new Uint8Array(fs.readFileSync((await download.path())!)));
    const slideXml = strFromU8(files['ppt/slides/slide1.xml']!);
    const rels = strFromU8(files['ppt/slides/_rels/slide1.xml.rels']!);
    expect(slideXml.match(/<a:hlinkClick r:id="rId\d+"\/>/g)).toHaveLength(2);
    expect(rels).toContain('Target="https://example.com/plan" TargetMode="External"');
    expect(rels).toContain('Target="https://example.com/notes" TargetMode="External"');
  });

  test('cells copied from a spreadsheet paste as a table, and a typed slide number goes to that slide', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Budget talk');
    await typeInBox(page, 0, 'Budget');
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+m');
    await page.keyboard.press('Escape');
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-blank').click();
    await expect(thumbs(page)).toHaveCount(3);

    // As Google Sheets puts cells on the clipboard.
    await page.evaluate(async () => {
      const html = '<google-sheets-html-origin><table><tbody><tr><td>Item</td><td>Cost</td></tr><tr><td>Rent</td><td>1,200</td></tr><tr><td>Food</td><td>450</td></tr></tbody></table>';
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob(['Item\tCost\nRent\t1,200\nFood\t450'], { type: 'text/plain' }),
      })]);
    });
    await clickSlide(page, 640, 700);
    await page.keyboard.press('ControlOrMeta+v');
    const table = sheet(page).locator('[data-el][data-type="table"]');
    await expect(table).toHaveCount(1);
    await expect(elements(page, 'text')).toHaveCount(0);
    const cells = await table.evaluate(node => [...node.querySelectorAll('.slide-text')].map(cell => cell.textContent));
    expect(cells).toEqual(['Item', 'Cost', 'Rent', '1,200', 'Food', '450']);
    await shot(page, 'habits-02-pasted-table');
    // Words without tabs still come in as a text box.
    await page.evaluate(() => navigator.clipboard.writeText('Just one line of words'));
    await clickSlide(page, 640, 40);
    await page.keyboard.press('ControlOrMeta+v');
    await expect(elements(page, 'text')).toHaveCount(1);

    // Presenting: 3 and Enter shows the third slide; Enter alone goes on.
    await thumbs(page).first().click();
    await page.getByTestId('present').click();
    const present = page.getByTestId('present-view');
    await expect(present).toHaveAttribute('data-slide-index', '0');
    await page.keyboard.press('3');
    await page.keyboard.press('Enter');
    await expect(present).toHaveAttribute('data-slide-index', '2');
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
    await expect(present).toHaveAttribute('data-slide-index', '0');
    await page.keyboard.press('Enter');
    await expect(present).toHaveAttribute('data-slide-index', '1');
    await page.keyboard.press('Escape');
  });
});
