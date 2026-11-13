import { strToU8, zipSync } from 'fflate';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { cellStyle, expectCell, expectSaved, goTo, shotPath, waitForGrid } from './sheets.helpers';

/** A small Excel workbook: a sales table with a bold header and a total formula. */
function makeWorkbook(): Buffer {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkg = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const text = (ref: string, value: string, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t>${value}</t></is></c>`;
  const number = (ref: string, value: number) => `<c r="${ref}"><v>${value}</v></c>`;
  const rows = [
    `<row r="1">${text('A1', 'Month', 1)}${text('B1', 'Sales', 1)}</row>`,
    `<row r="2">${text('A2', 'Jan')}${number('B2', 120)}</row>`,
    `<row r="3">${text('A3', 'Feb')}${number('B3', 150)}</row>`,
    `<row r="4">${text('A4', 'Mar')}${number('B4', 90)}</row>`,
    `<row r="5">${text('A5', 'Total')}<c r="B5"><f>SUM(B2:B4)</f><v>360</v></c></row>`,
  ];
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`${head}<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`${head}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`${head}<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`${head}<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="10"/></font><font><b/><sz val="10"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(`${head}<worksheet xmlns="${main}"><sheetData>${rows.join('')}</sheetData></worksheet>`),
  }));
}

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await page.locator('label[title="Add files"]:visible input[type="file"]').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByTestId('viewer-header')).toContainText(name, { timeout: 30_000 });
}

test.describe('spreadsheet files in the Drive', () => {
  test.setTimeout(240_000);

  test('an uploaded Excel file shows as a spreadsheet and opens as one to edit', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    const workbook = makeWorkbook();
    await upload(page, 'Sales.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook);

    // The file itself shows as a spreadsheet to look at.
    await expect(page.getByTestId('sheet-preview')).toBeVisible({ timeout: 30_000 });
    await waitForGrid(page);
    await expectCell(page, 'B5', '360');
    await page.screenshot({ path: shotPath(testInfo, 'open-file-preview.png') });

    // Opening it makes Sales.irissheet beside it, with the file's content.
    await page.getByTestId('viewer-open-as-document').click();
    await expect(page.getByTestId('document-title')).toHaveText('Sales', { timeout: 30_000 });
    await waitForGrid(page);
    await expectCell(page, 'A1', 'Month');
    await expectCell(page, 'B5', '360');
    expect(await cellStyle(page, 'A1')).toMatchObject({ b: 1 });
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('import=');
    await expect(page.getByTestId('sheet-tabs')).not.toContainText('Sheet1');
    // Bringing the file in is not a step to undo.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

    await goTo(page, 'B2');
    await page.keyboard.type('200');
    await page.keyboard.press('Enter');
    await expectCell(page, 'B5', '440');
    await expectSaved(page);
    await page.screenshot({ path: shotPath(testInfo, 'open-file-editing.png') });

    // Back in the folder both are there; opening the file again opens the same spreadsheet, edits kept.
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page.getByText('Sales.irissheet').or(page.getByText('Sales', { exact: true })).first()).toBeVisible({ timeout: 30_000 });
    await page.getByText('Sales.xlsx').first().click();
    await expect(page.getByTestId('viewer-open-as-document')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('viewer-open-as-document').click();
    await expect(page.getByTestId('document-title')).toHaveText('Sales', { timeout: 30_000 });
    await waitForGrid(page);
    await expectCell(page, 'B5', '440');
  });

  test('a CSV file opens as a spreadsheet, and its view is only for looking', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await upload(page, 'Tasks.csv', 'text/csv', Buffer.from('Task,Done\nWrite,1\nTest,0\n'));
    await expect(page.getByTestId('sheet-preview')).toBeVisible({ timeout: 30_000 });
    await waitForGrid(page);
    await expectCell(page, 'A2', 'Write');
    // Nothing typed into the view changes it.
    await goTo(page, 'A2');
    await page.keyboard.type('Changed');
    await page.keyboard.press('Enter');
    await expectCell(page, 'A2', 'Write');

    await page.getByTestId('viewer-open-as-document').click();
    await expect(page.getByTestId('document-title')).toHaveText('Tasks', { timeout: 30_000 });
    await waitForGrid(page);
    await expectCell(page, 'A3', 'Test');
    await expect(page.getByTestId('sheet-tabs')).toContainText('Tasks');
    await expect(page.getByTestId('sheet-tabs')).not.toContainText('Sheet1');
  });
});
