// Uploading one file leaves the folder open: the new row is highlighted for
// a moment and a message names it. On a phone the file used to replace the list.
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable, fileRow, uploadFilesInput } from './test-utils';

test('uploading one file on a phone stays in the folder and highlights the new row', async ({ page, relayUrl }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Uploads');
  await expectFolderEditable(page);
  const folderUrl = page.url();

  await uploadFilesInput(page).setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('Coffee 3.50') });
  await expect(page.getByText('Uploaded receipt.txt', { exact: true })).toBeVisible({ timeout: 30_000 });
  const row = fileRow(page, 'receipt.txt');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-changed', '');
  await expect(row).toBeInViewport();
  expect(page.url()).toBe(folderUrl);
  await expect(page.getByTestId('viewer-back')).toHaveCount(0);
  await expect(page.getByTestId('folder-header')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('uploaded-phone.png') });

  // The highlight is brief.
  await expect(row).not.toHaveAttribute('data-changed', /.*/, { timeout: 15_000 });
});
