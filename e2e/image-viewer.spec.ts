import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { uploadFilesInput } from './test-utils';

// A 1x1 red PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test('an uploaded picture is shown from the app\'s own address, without an error on the way', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Image Test');
  await uploadFilesInput(page).setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: PIXEL });

  const image = page.getByTestId('image-viewer');
  const error = page.getByText('Unable to display file content');
  await page.getByTestId('file-list').getByRole('link', { name: /red\.png/ }).dblclick();
  await expect(image.or(error)).toBeVisible({ timeout: 30_000 });
  await expect(error).toHaveCount(0);
  await expect(image).toHaveAttribute('src', /\/htree\/nhash1/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
});
