// A photo opened in Photos is shared as a file is in its folder: its link,
// and anyone with the link can view it once that is chosen.
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { jpeg, picture } from './photos.helpers';

test.describe('sharing from Photos', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('the open photo is shared by its link, and opens signed out', async ({ page, browser, relayUrl }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Photo Sharer');
    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Photos' }).click();
    await page.getByTestId('photos-upload-input').setInputFiles(jpeg('sunset.jpg', await picture(page, '#fb923c', '#7c2d12', 800, 500)));
    await page.getByTestId('photo-tile').first().click({ timeout: 30_000 });
    const viewer = page.getByTestId('photo-viewer');
    await expect(viewer).toBeVisible();

    await viewer.getByTestId('photo-viewer-share').click();
    const modal = page.getByTestId('share-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('general-access-select').selectOption('link');
    await page.getByTestId('general-access-link').click({ timeout: 30_000 });
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/#\/npub1[a-z0-9]+\//);
    await page.screenshot({ path: testInfo.outputPath('photo-share.png') });

    // Escape closes the dialog, and the photo stays open under it.
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(viewer).toBeVisible();

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(`${new URL(visitor.url()).origin}/#${link.split('#')[1]}`);
      await expect(async () => {
        await visitor.reload();
        await expect(visitor.locator('img[alt="sunset.jpg"], img[src*="sunset.jpg"]').first()).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 90_000 });
    } finally {
      await visitorContext.close();
    }
  });
});
