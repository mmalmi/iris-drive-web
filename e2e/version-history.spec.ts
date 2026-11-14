// Version history in all three editors: earlier versions are listed newest
// first, shown read-only in the editor's own view, restored as one edit that
// undo takes back and a reload keeps, and copied into a document of their own.
import { expect, test, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';
import { cellText, clickCell, createSpreadsheet, expectCell, typeTable, waitForGrid } from './sheets.helpers';
import { createPresentation, elements, sheet, thumbs, typeInBox } from './slides.helpers';

/** Saves this far apart are separate versions here, instead of minutes apart as in real use. */
const VERSION_GAP_MS = 2000;

async function shortVersionGaps(page: Page): Promise<void> {
  await page.addInitScript((gapMs) => {
    (window as unknown as { __versionHistory?: { gapMs: number } }).__versionHistory = { gapMs };
  }, VERSION_GAP_MS);
}

/** Long enough that the next save starts a version of its own. */
async function pause(page: Page): Promise<void> {
  await page.waitForTimeout(VERSION_GAP_MS + 1500);
}

function panel(page: Page) {
  return page.getByTestId('version-history-panel');
}

function versions(page: Page) {
  return panel(page).getByTestId('version-item');
}

function bar(page: Page) {
  return page.getByTestId('version-bar');
}

async function openFromMenu(page: Page, menu: string): Promise<void> {
  await page.getByTestId(menu).click();
  await page.getByTestId('version-history').click();
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
}

/** Opens a version, counted from the newest, and waits for it to be shown. */
async function view(page: Page, index: number): Promise<void> {
  await versions(page).nth(index).click();
  await expect(bar(page)).toBeVisible({ timeout: 30_000 });
  await expect(bar(page)).toContainText('Viewing a version from');
}

async function restore(page: Page): Promise<void> {
  await bar(page).getByTestId('version-restore').click();
  await expect(bar(page)).toBeHidden({ timeout: 30_000 });
  await expect(panel(page)).toBeHidden();
}

async function makeCopy(page: Page, title: string): Promise<void> {
  await bar(page).getByTestId('version-copy').click();
  await expect(page.getByText(`Made a copy: ${title}`)).toBeVisible({ timeout: 30_000 });
}

async function openFromFolder(page: Page, title: string): Promise<void> {
  await page.getByRole('link', { name: 'Back to folder' }).click();
  await page.getByTestId('file-list').getByText(title, { exact: true }).click();
  await expect(page.getByTestId('document-title')).toHaveText(title, { timeout: 30_000 });
}

test.describe('version history', () => {
  test.setTimeout(300_000);

  test('a document shows, restores and copies earlier versions', async ({ page, relayUrl }, testInfo) => {
    await shortVersionGaps(page);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Plan');

    await typeInDocument(page, 'Alpha');
    await expectSaved(page);
    await pause(page);
    await typeInDocument(page, ' beta');
    await expectSaved(page);
    await pause(page);
    await typeInDocument(page, ' gamma');
    await expectSaved(page);

    await openFromMenu(page, 'document-more');
    await expect.poll(() => versions(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(versions(page).first()).toContainText('Current version');
    await expect(panel(page).getByTestId('version-day').first()).toHaveText('Today');

    // The oldest of the three: read-only, in the document's own page.
    await view(page, 2);
    const shown = page.getByTestId('document-version').locator('.ProseMirror');
    await expect(shown).toHaveText('Alpha');
    await expect(shown).toHaveAttribute('contenteditable', 'false');
    await expect(documentBody(page)).toBeHidden();

    await view(page, 1);
    await expect(shown).toHaveText('Alpha beta');
    await page.screenshot({ path: testInfo.outputPath('document-version.png') });
    await makeCopy(page, 'Copy of Plan');

    // Choosing the newest version is the document itself again.
    await versions(page).first().click();
    await expect(bar(page)).toBeHidden();
    await expect(documentBody(page)).toHaveText('Alpha beta gamma');

    await view(page, 2);
    await restore(page);
    await expect(documentBody(page)).toHaveText('Alpha');
    await expectSaved(page);

    // Restoring was one edit: undo takes it back, redo puts it again.
    await documentBody(page).click();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(documentBody(page)).toHaveText('Alpha beta gamma');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(documentBody(page)).toHaveText('Alpha');
    await expectSaved(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toHaveText('Alpha', { timeout: 60_000 });

    // The keyboard opens history too, and Escape returns to the document.
    await documentBody(page).click();
    await page.keyboard.press('Control+Alt+Shift+KeyH');
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    // The restore is a version of its own, even right after the edit before it, which stays listed.
    await expect.poll(() => versions(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
    await expect(versions(page).first().getByTestId('version-restored')).toContainText('Restored from');
    await view(page, 1);
    await expect(shown).toHaveText('Alpha beta gamma');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toBeHidden();
    await expect(panel(page)).toBeHidden();
    await expect(documentBody(page)).toHaveText('Alpha');

    await openFromFolder(page, 'Copy of Plan');
    await expect(documentBody(page)).toHaveText('Alpha beta', { timeout: 60_000 });
  });

  test('a spreadsheet shows, restores and copies earlier versions', async ({ page, relayUrl }, testInfo) => {
    await shortVersionGaps(page);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Stock');

    await typeTable(page, 'A1', [['Apples', '1']]);
    await expectSaved(page);
    await pause(page);
    await typeTable(page, 'A2', [['Pears', '2']]);
    await expectSaved(page);
    await pause(page);
    await typeTable(page, 'B1', [['10']]);
    await expectSaved(page);

    await openFromMenu(page, 'sheet-more');
    await expect.poll(() => versions(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(versions(page).first()).toContainText('Current version');

    await view(page, 2);
    await expectCell(page, 'A1', 'Apples');
    await expectCell(page, 'B1', '1');
    await expectCell(page, 'A2', '');
    await expect(page.getByTestId('sheet-toolbar')).toBeHidden();

    await view(page, 1);
    await expectCell(page, 'A2', 'Pears');
    await expectCell(page, 'B1', '1');
    await page.screenshot({ path: testInfo.outputPath('spreadsheet-version.png') });
    await makeCopy(page, 'Copy of Stock');

    await view(page, 2);
    await restore(page);
    await waitForGrid(page);
    await expectCell(page, 'A1', 'Apples');
    await expectCell(page, 'B1', '1');
    await expectCell(page, 'A2', '');
    await expectSaved(page);

    await clickCell(page, 'D5');
    await page.keyboard.press('ControlOrMeta+z');
    await expectCell(page, 'A2', 'Pears');
    await expectCell(page, 'B1', '10');
    await page.keyboard.press('ControlOrMeta+y');
    await expectCell(page, 'A2', '');
    await expectCell(page, 'B1', '1');
    await expectSaved(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGrid(page);
    await expectCell(page, 'A1', 'Apples');
    await expectCell(page, 'B1', '1');
    expect(await cellText(page, 'A2')).toBe('');

    await page.keyboard.press('Control+Alt+Shift+KeyH');
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    await view(page, 1);
    await expectCell(page, 'B1', '10');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await waitForGrid(page);
    await expectCell(page, 'B1', '1');

    await openFromFolder(page, 'Copy of Stock');
    await waitForGrid(page);
    await expectCell(page, 'A1', 'Apples');
    await expectCell(page, 'A2', 'Pears');
    await expectCell(page, 'B1', '1');
  });

  test('a presentation shows, restores and copies earlier versions', async ({ page, relayUrl }, testInfo) => {
    await shortVersionGaps(page);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Deck');

    await typeInBox(page, 0, 'Hello deck');
    await page.keyboard.press('Escape');
    await expectSaved(page);
    await pause(page);
    await page.getByTestId('new-slide').click();
    await expect(thumbs(page)).toHaveCount(2);
    await expectSaved(page);
    await pause(page);
    await page.getByTestId('new-slide').click();
    await expect(thumbs(page)).toHaveCount(3);
    await expectSaved(page);

    await openFromMenu(page, 'slides-more');
    await expect.poll(() => versions(page).count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await expect(versions(page).first()).toContainText('Current version');

    await view(page, 2);
    await expect(thumbs(page)).toHaveCount(1);
    await expect(sheet(page)).toContainText('Hello deck');
    await expect(page.getByTestId('new-slide')).toBeHidden();

    await view(page, 1);
    await expect(thumbs(page)).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('presentation-version.png') });
    await makeCopy(page, 'Copy of Deck');

    await view(page, 2);
    await restore(page);
    await expect(thumbs(page)).toHaveCount(1);
    await expect(sheet(page)).toContainText('Hello deck');
    await expectSaved(page);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(thumbs(page)).toHaveCount(3);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(thumbs(page)).toHaveCount(1);
    await expectSaved(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(thumbs(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(elements(page, 'text').first()).toContainText('Hello deck');

    await page.keyboard.press('Control+Alt+Shift+KeyH');
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    await view(page, 1);
    await expect(thumbs(page)).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(thumbs(page)).toHaveCount(1);

    await openFromFolder(page, 'Copy of Deck');
    await expect(thumbs(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(sheet(page)).toContainText('Hello deck');
  });

  test('on a phone the list is a full-screen sheet', async ({ page, relayUrl }, testInfo) => {
    await shortVersionGaps(page);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Pocket');
    await typeInDocument(page, 'First');
    await expectSaved(page);
    await pause(page);
    await typeInDocument(page, ' second');
    await expectSaved(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await openFromMenu(page, 'document-more');
    const box = await panel(page).boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('phone-list.png') });

    // A version is shown in place of the list, which comes back from the bar.
    await view(page, 1);
    await expect(panel(page)).toBeHidden();
    await expect(page.getByTestId('document-version').locator('.ProseMirror')).toHaveText('First');
    await page.screenshot({ path: testInfo.outputPath('phone-version.png') });
    await bar(page).getByTestId('version-list').click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByTestId('version-history-close').click();
    await expect(panel(page)).toBeHidden();
    await expect(bar(page)).toBeHidden();
    await expect(documentBody(page)).toHaveText('First second');
  });
});
