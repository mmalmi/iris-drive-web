import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { uploadFilesInput } from './test-utils';

// Opening the share dialog, copying its address and Escape are covered with
// documents, files and presentations; this is the QR code and the other ways out.
test('the share dialog shows a QR code and closes from its backdrop or its QR code', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Share Test');
  await uploadFilesInput(page).setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('share me') });
  const share = page.getByTestId('viewer-share');
  const modal = page.getByTestId('share-modal');

  await share.click();
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('share-qr-code')).toHaveAttribute('src', /^data:image\/png/);
  await page.getByTestId('share-modal-backdrop').click({ position: { x: 10, y: 10 } });
  await expect(modal).toBeHidden();

  await share.click();
  await expect(modal).toBeVisible();
  await page.getByTestId('share-qr-code').click();
  await expect(modal).toBeHidden();
});
