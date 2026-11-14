// Albums in Photos: the folders that hold photos, and photos chosen in the
// timeline put into a new one by their content. With PHOTOS_SHOTS set it
// saves screenshots there.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, fileRow, uploadIntoFolder } from './test-utils';
import { expectShown, jpeg, picture, shot } from './photos.helpers';

const tiles = (page: Page) => page.getByTestId('photo-tile');
const cards = (page: Page) => page.getByTestId('album-card');
const card = (page: Page, name: string) => cards(page).filter({ has: page.getByTestId('album-name').getByText(name, { exact: true }) });
const selectionCount = (page: Page) => page.getByTestId('photos-selection-count');

/** Chooses a photo of the grid from its round box, which shows on hover. */
async function choose(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name, exact: true }).hover();
  await page.getByRole('checkbox', { name: `Select ${name}` }).click();
}

test.describe('albums in Photos', () => {
  test.setTimeout(180_000);

  test('folders with photos are albums, and chosen photos go into a new one', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Album Test');
    const sidebar = page.getByTestId('drive-sidebar');

    // Two folders with photos in them.
    await createAndEnterFolder(page, 'Trip');
    await uploadIntoFolder(page, [
      jpeg('sea.jpg', await picture(page, '#7dd3fc', '#0c4a6e', 1200, 900)),
      jpeg('boat.jpg', await picture(page, '#fecaca', '#7f1d1d', 900, 1200)),
    ]);
    await sidebar.getByRole('link', { name: 'My Drive' }).click();
    await expect(fileRow(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await createAndEnterFolder(page, 'Garden');
    await uploadIntoFolder(page, jpeg('rose.jpg', await picture(page, '#fbcfe8', '#166534', 1200, 1200)));

    // Both are albums.
    await sidebar.getByRole('link', { name: 'Photos' }).click();
    await expect(tiles(page)).toHaveCount(3, { timeout: 30_000 });
    await page.getByTestId('albums-tab').click();
    await expect(page).toHaveURL(/#\/photos\/albums$/);
    await expect(sidebar.getByRole('link', { name: 'Photos' })).toHaveAttribute('aria-current', 'page');
    await expect(cards(page)).toHaveCount(2, { timeout: 30_000 });
    await expect(card(page, 'Trip').getByTestId('album-count')).toHaveText('2 photos');
    await expect(card(page, 'Garden').getByTestId('album-count')).toHaveText('1 photo');
    await expect(card(page, 'Trip').locator('img')).toHaveJSProperty('complete', true);

    // An album shows its own photos; back is the albums.
    await card(page, 'Trip').click();
    await expect(page).toHaveURL(new RegExp(`#/photos/album/${profileId}/Trip$`));
    await expect(page.getByTestId('album-title')).toHaveText('Trip');
    await expect(page.getByTestId('album-header-count')).toHaveText('2 photos');
    await expect(tiles(page)).toHaveCount(2);
    await expect(page.getByTestId('album-open-folder')).toHaveAttribute('href', `#/${profileId}/main/Trip`);
    await shot(page, 'album-desktop-light');
    await page.getByTestId('album-back').click();
    await expect(page).toHaveURL(/#\/photos\/albums$/);
    await shot(page, 'albums-desktop-light');

    // Two photos chosen in the timeline go into a new album.
    await page.getByTestId('photos-tab').click();
    await expect(tiles(page)).toHaveCount(3);
    await choose(page, 'rose.jpg');
    await expect(selectionCount(page)).toHaveText('1 selected');
    // While some are chosen, a click chooses.
    await page.getByRole('link', { name: 'sea.jpg', exact: true }).click();
    await expect(selectionCount(page)).toHaveText('2 selected');
    await expect(page.getByTestId('photo-viewer')).toHaveCount(0);
    await shot(page, 'selection-desktop-light');
    await page.getByTestId('photos-add-to-album').click();
    await page.getByTestId('new-album').click();
    await page.getByTestId('new-album-name').fill('Best of');
    await page.getByTestId('new-album-create').click();
    await expect(page.getByText('Added 2 photos to Best of')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('photos-selection-bar')).toHaveCount(0);

    // It is an album of its own, and the timeline still shows each photo once.
    await page.getByTestId('albums-tab').click();
    await expect(cards(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(card(page, 'Best of').getByTestId('album-count')).toHaveText('2 photos');
    await page.getByTestId('photos-tab').click();
    await expect(tiles(page)).toHaveCount(3);
    for (const name of ['sea.jpg', 'boat.jpg', 'rose.jpg']) await expectShown(page, name);

    // Adding the same photos again adds nothing.
    await choose(page, 'sea.jpg');
    await page.getByTestId('photos-add-to-album').click();
    await page.getByTestId('album-choice').filter({ hasText: 'Best of' }).click();
    await expect(page.getByText('Already in Best of')).toBeVisible({ timeout: 30_000 });

    // The album is a folder under Photos in My Drive, and its Share opens the share dialog.
    await page.getByTestId('albums-tab').click();
    await card(page, 'Best of').click();
    await expect(page.getByTestId('album-title')).toHaveText('Best of');
    await expect(tiles(page)).toHaveCount(2);
    await expect(page.getByTestId('album-open-folder')).toHaveAttribute('href', `#/${profileId}/main/Photos/Best%20of`);
    // Its photos open full screen there, and close back to it.
    await tiles(page).first().click();
    await expect(page.getByTestId('photo-viewer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/photos\/album\/[^?]+\/Photos\/Best%20of$/);
    await page.getByTestId('album-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await expect(page.getByTestId('share-tab-people')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toHaveCount(0);

    // On a phone, in the dark: a long press chooses.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'album-phone-dark');
    await page.getByTestId('album-back').click();
    await expect(cards(page)).toHaveCount(3);
    await shot(page, 'albums-phone-dark');
    await page.getByTestId('photos-tab').click();
    const rose = page.getByRole('link', { name: 'rose.jpg', exact: true });
    const box = (await rose.boundingBox())!;
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: 'touch', isPrimary: true, bubbles: true };
    await rose.dispatchEvent('pointerdown', at);
    await page.waitForTimeout(700);
    await rose.dispatchEvent('pointerup', at);
    await expect(selectionCount(page)).toHaveText('1 selected');
    await page.getByRole('link', { name: 'boat.jpg', exact: true }).click();
    await expect(selectionCount(page)).toHaveText('2 selected');
    await shot(page, 'selection-phone-dark');
    await page.getByTestId('photos-selection-cancel').click();
    await expect(page.getByTestId('photos-selection-bar')).toHaveCount(0);
  });
});
