import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  bandsSvg,
  createPresentation,
  elements,
  expectSlidesSaved,
  sheet,
  shot,
  thumbs,
  typeInBox,
} from './slides.helpers';

/** Two people on two devices, each with their own account, working on one deck. Their saves reach each other after a few seconds. */

async function inviteLink(page: Page): Promise<string> {
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
  const create = page.getByTestId('share-people-create');
  await expect(create.or(page.getByTestId('share-people-link'))).toBeVisible({ timeout: 30_000 });
  if (await create.isVisible()) await create.click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-role').selectOption('editor');
  await page.getByTestId('share-people-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/share-join/');
  return link;
}

const titles = (page: Page) => thumbs(page).evaluateAll(nodes => nodes.map(node => node.querySelector('[data-el]')?.textContent?.trim()));

test.describe('a presentation shared for editing', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('the owner and a guest build one deck from two devices', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await createPresentation(page, 'Plan');
    await typeInBox(page, 0, 'Owner\'s title');
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);

    await page.getByTestId('document-share').click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/main\/Plan\.irisslides$/, { timeout: 30_000 });
    await expect(sheet(page)).toContainText('Owner\'s title', { timeout: 60_000 });

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await createDriveProfile(guest, 'Guest');
      await guest.goto(`${new URL(guest.url()).origin}/#${link.split('#')[1]}`);
      await expect(guest).toHaveURL(/\/main\/Plan\.irisslides$/, { timeout: 90_000 });
      await expect(sheet(guest)).toContainText('Owner\'s title', { timeout: 90_000 });
      await expect(guest.getByTestId('slides-toolbar')).toBeVisible({ timeout: 30_000 });
      // An empty deck is given its first slide once, by whoever made it.
      await expect(thumbs(guest)).toHaveCount(1);

      // The guest adds a slide with a picture while the owner picks a theme and writes the subtitle.
      await guest.getByTestId('new-slide').click();
      await typeInBox(guest, 0, 'Guest\'s slide');
      await guest.keyboard.press('Escape');
      await guest.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(400, 240) });
      await expect(elements(guest, 'image')).toHaveCount(1, { timeout: 30_000 });
      await page.getByTestId('deck-theme').click();
      await page.getByTestId('theme-ocean').click();
      await typeInBox(page, 1, 'Owner\'s subtitle');
      await page.keyboard.press('Escape');
      await expectSlidesSaved(guest);
      await expectSlidesSaved(page);

      await expect(thumbs(page)).toHaveCount(2, { timeout: 90_000 });
      await expect(sheet(guest).locator('.slide-surface')).toHaveCSS('background-color', 'rgb(244, 249, 252)', { timeout: 90_000 });
      await thumbs(guest).first().click();
      await expect(sheet(guest)).toContainText('Owner\'s subtitle', { timeout: 90_000 });
      // The picture the guest stored shows for the owner.
      await thumbs(page).nth(1).click();
      await expect(sheet(page)).toContainText('Guest\'s slide');
      await expect.poll(
        () => elements(page, 'image').locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth).catch(() => 0),
        { timeout: 90_000 },
      ).toBeGreaterThan(0);
      await shot(page, 'together-01-owner-sees-guest-slide');

      // At the same moment: the owner moves the guest's slide to the front and recolours its
      // picture's neighbour, the guest retitles that slide and adds a third.
      await thumbs(page).nth(1).click();
      await page.keyboard.press('Alt+ArrowUp');
      expect(await titles(page)).toEqual(['Guest\'s slide', 'Owner\'s title']);
      await thumbs(guest).nth(1).click();
      await typeInBox(guest, 0, ', renamed');
      await guest.keyboard.press('Escape');
      await guest.getByTestId('new-slide').click();
      await typeInBox(guest, 0, 'Third');
      await guest.keyboard.press('Escape');
      await expectSlidesSaved(page);
      await expectSlidesSaved(guest);

      // Both end up with the same three slides in the same order, nothing lost or doubled.
      await expect.poll(() => titles(page), { timeout: 90_000 }).toHaveLength(3);
      await expect.poll(() => titles(guest), { timeout: 90_000 }).toContain('Guest\'s slide, renamed');
      await expect.poll(async () => JSON.stringify(await titles(guest)), { timeout: 90_000 }).toBe(JSON.stringify(await titles(page)));
      const final = await titles(page);
      expect([...final].sort()).toEqual(['Guest\'s slide, renamed', 'Owner\'s title', 'Third']);
      expect(final.indexOf('Guest\'s slide, renamed')).toBeLessThan(final.indexOf('Owner\'s title'));
      await shot(page, 'together-02-owner-final');
      await shot(guest, 'together-03-guest-final');

      // The owner's undo takes back the owner's move, not the guest's work.
      await page.getByRole('button', { name: 'Undo' }).click();
      const undone = await titles(page);
      expect(undone).toHaveLength(3);
      expect(undone.indexOf('Owner\'s title')).toBeLessThan(undone.indexOf('Guest\'s slide, renamed'));
    } finally {
      await guestContext.close();
    }
  });
});
