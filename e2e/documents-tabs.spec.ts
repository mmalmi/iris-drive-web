import { expect, test } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

test.describe('one account in two tabs', () => {
  test.setTimeout(180_000);

  test('writing in one document while another tab shows a different one loses nothing', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Source');
    await typeInDocument(page, 'Written in the source.');
    await expectSaved(page);
    const sourceUrl = page.url();

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Target');
    const targetUrl = page.url();

    // A second tab opens the other document and only looks at it.
    const second = await context.newPage();
    await second.goto(sourceUrl);
    await expect(documentBody(second)).toContainText('Written in the source.', { timeout: 60_000 });
    await second.waitForTimeout(2000);

    await page.bringToFront();
    await typeInDocument(page, 'Written in the target.');
    await expectSaved(page);
    await page.waitForTimeout(3000);
    await second.close();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Written in the target.', { timeout: 60_000 });
    await page.goto(sourceUrl);
    await expect(documentBody(page)).toContainText('Written in the source.', { timeout: 60_000 });
    await page.goto(targetUrl);
    await expect(documentBody(page)).toContainText('Written in the target.', { timeout: 60_000 });
  });

  test('writing in two documents in two tabs at the same time keeps both', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Left');
    const leftUrl = page.url();
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Right');
    const rightUrl = page.url();

    const second = await context.newPage();
    await second.goto(leftUrl);
    await expect(documentBody(second)).toBeVisible({ timeout: 60_000 });

    for (let round = 1; round <= 3; round += 1) {
      await typeInDocument(second, ` Left ${round}.`);
      await typeInDocument(page, ` Right ${round}.`);
      await Promise.all([expectSaved(second), expectSaved(page)]);
    }
    await page.waitForTimeout(3000);
    await second.close();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Right 3.', { timeout: 60_000 });
    await page.goto(leftUrl);
    await expect(documentBody(page)).toContainText('Left 1. Left 2. Left 3.', { timeout: 60_000 });
    await page.goto(rightUrl);
    await expect(documentBody(page)).toContainText('Right 1. Right 2. Right 3.', { timeout: 60_000 });
  });
});
