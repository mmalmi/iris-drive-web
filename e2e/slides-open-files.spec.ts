import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { uploadAndOpen } from './test-utils';
import { inheritedPptx } from './slides.pptxSample';
import { expectSlidesSaved, thumbs } from './slides.helpers';

/** Adds a file to the open folder, which stays open, and opens it. */
async function upload(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await uploadAndOpen(page, { name, mimeType, buffer });
}

test.describe('presentation files in the Drive', () => {
  test.setTimeout(240_000);

  test('an uploaded PowerPoint file opens as a presentation, and opening it again keeps that one', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await upload(page, 'Pitch.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', Buffer.from(inheritedPptx()));

    await page.getByTestId('viewer-open-as-document').click();
    await expect(page.getByTestId('document-title')).toHaveText('Pitch', { timeout: 30_000 });
    await expect.poll(() => thumbs(page).count(), { timeout: 30_000 }).toBeGreaterThan(0);
    const slides = await thumbs(page).count();
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('import=');
    await expectSlidesSaved(page);

    // Back to the file and open it again: the same presentation, not a second copy of its slides.
    await page.goBack();
    await expect(page.getByTestId('viewer-open-as-document')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('viewer-open-as-document').click();
    await expect(page.getByTestId('document-title')).toHaveText('Pitch', { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await expect(thumbs(page)).toHaveCount(slides);
  });
});
