import fs from 'node:fs';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  activeCell,
  cellStyle,
  createSpreadsheet,
  dragCells,
  expectCell,
  goTo,
  shotPath,
  typeTable,
} from './sheets.helpers';

test.describe('numbers in the reader\'s own way, and Excel files', () => {
  test.setTimeout(240_000);
  test.use({ locale: 'de-DE', permissions: ['clipboard-read', 'clipboard-write'] });

  test('a German browser writes decimal commas, and a workbook goes out to Excel and comes back', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Haushalt');
    await typeTable(page, 'A1', [
      ['Posten', 'Betrag', 'Datum'],
      ['Miete', '1.234,5', '13.11.2026'],
      ['Essen', '89,90', '1.12.2026'],
      ['Summe', '=SUM(B2:B3)', ''],
    ]);
    await expectCell(page, 'B2', '1.234,5');
    await expectCell(page, 'B4', '1.324,4');
    await expectCell(page, 'C2', '13.11.2026');
    await goTo(page, 'B3');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('89,9');
    await page.screenshot({ path: shotPath(testInfo, 'files-locale-de.png') });

    // Set for everyone who opens it: English (US) writing.
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('sheet-locale').click();
    await page.getByTestId('sheet-locale-en-US').click();
    await expectCell(page, 'B2', '1,234.5');
    await expectCell(page, 'C2', '11/13/2026');
    await page.getByTestId('sheet-more').click();
    await page.getByTestId('sheet-locale').click();
    await expect(page.getByTestId('sheet-locale-en-US')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('sheet-locale-auto').click();
    await expectCell(page, 'B2', '1.234,5');

    // Looks to carry over: borders and bold.
    await dragCells(page, 'A1', 'C4');
    await page.getByTestId('sheet-borders').click();
    await page.getByTestId('border-all').click();
    await dragCells(page, 'A1', 'C1');
    await page.getByRole('button', { name: 'Bold' }).click();

    // Out as an Excel file.
    await page.getByTestId('sheet-more').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('sheet-download-xlsx').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('Haushalt.xlsx');
    const file = testInfo.outputPath('Haushalt.xlsx');
    await download.saveAs(file);
    expect(fs.statSync(file).size).toBeGreaterThan(1000);

    // Back in through the menu, as new sheets beside the first.
    await page.getByTestId('sheet-csv-input').setInputFiles(file);
    await expect(page.getByTestId('sheet-tabs')).toContainText('Haushalt');
    await expectCell(page, 'B4', '1.324,4');
    await goTo(page, 'B4');
    await expect(page.getByTestId('sheet-formula-input')).toHaveValue('=SUM(B2:B3)');
    expect(await cellStyle(page, 'A1')).toMatchObject({ b: 1, bt: 's' });

    // And by dropping it on the spreadsheet.
    const bytes = [...fs.readFileSync(file)];
    const transfer = await page.evaluateHandle((data) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], 'Dropped.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      return transfer;
    }, bytes);
    const editor = page.getByTestId('document-editor');
    await editor.dispatchEvent('dragover', { dataTransfer: transfer });
    await expect(page.getByTestId('sheet-drop-zone')).toBeVisible();
    await page.screenshot({ path: shotPath(testInfo, 'files-drop.png') });
    await editor.dispatchEvent('drop', { dataTransfer: transfer });
    await expect(page.getByTestId('sheet-drop-zone')).toHaveCount(0);
    await expect(page.getByTestId('sheet-tabs')).toContainText('Dropped');
    await expectCell(page, 'C3', '1.12.2026');
    await expect(activeCell(page)).toHaveAttribute('data-cell', 'A1');
  });
});
