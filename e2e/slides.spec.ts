import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  clickSlide,
  createPresentation,
  elements,
  expectSlidesSaved,
  sheet,
  shot,
  thumbs,
  typeInBox,
} from './slides.helpers';

test.describe('presentations in a Drive', () => {
  test.setTimeout(180_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a new presentation starts with a title slide and keeps what was written after a reload', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Field trip');
    await expect(page).toHaveURL(/Field%20trip\.irisslides$/);
    await shot(page, '01-new-deck');

    await typeInBox(page, 0, 'Field trip to the marsh');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'What we saw, and what comes next');
    await page.keyboard.press('Escape');
    await shot(page, '02-title-typed');

    await page.getByTestId('new-slide').click();
    await expect(thumbs(page)).toHaveCount(2);
    await typeInBox(page, 0, 'Birds');
    await page.keyboard.press('Escape');
    await typeInBox(page, 1, 'Two herons');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A kite, high up');
    await page.keyboard.press('Escape');
    await expect(elements(page, 'text').nth(1).locator('li')).toHaveCount(2);
    await shot(page, '03-second-slide');
    await expectSlidesSaved(page);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(thumbs(page)).toHaveCount(2, { timeout: 60_000 });
    await expect(sheet(page)).toContainText('Field trip to the marsh');
    await thumbs(page).nth(1).click();
    await expect(sheet(page)).toContainText('A kite, high up');
    await clickSlide(page, 1200, 700);
    await shot(page, '04-after-reload');
  });
});
