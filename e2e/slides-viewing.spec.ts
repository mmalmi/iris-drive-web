import { expect, test, type Page } from './fixtures';
import { flushPendingPublishes } from './test-utils';
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

/** A finger swipe across the page, as touch events. */
async function swipe(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, id: 1 });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(...from)] });
  for (let step = 1; step <= 5; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(from[0] + (to[0] - from[0]) * step / 5, from[1] + (to[1] - from[1]) * step / 5)],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

async function makeThreeSlides(page: Page): Promise<void> {
  await typeInBox(page, 0, 'Harbour walk');
  await page.keyboard.press('Escape');
  await typeInBox(page, 1, 'Saturday at ten');
  await page.keyboard.press('Escape');
  await page.getByTestId('new-slide').click();
  await typeInBox(page, 0, 'Bring');
  await page.keyboard.press('Escape');
  await typeInBox(page, 1, 'Good shoes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Something warm');
  await page.keyboard.press('Escape');
  await page.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(400, 240) });
  await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('speaker-notes').fill('Only for the one presenting.');
  await page.getByTestId('new-slide-layout').click();
  await page.getByTestId('layout-section').click();
  await typeInBox(page, 0, 'See you there');
  await page.keyboard.press('Escape');
  await expect(thumbs(page)).toHaveCount(3);
}

test.describe('looking at a presentation', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a shared link opens for viewing only, and can be presented from, also on a phone', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Harbour walk');
    await makeThreeSlides(page);
    await expectSlidesSaved(page);

    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(sharedUrl).toMatch(/#\/nhash1[a-z0-9]+\?doc=Harbour%20walk&kind=slides$/);
    await page.keyboard.press('Escape');

    // Someone else, on a laptop.
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(`${new URL(guest.url()).origin}/#${sharedUrl.split('#')[1]}`);
      await expect(guest.getByTestId('document-title')).toHaveText('Harbour walk', { timeout: 60_000 });
      await expect(thumbs(guest)).toHaveCount(3, { timeout: 60_000 });
      await expect(sheet(guest)).toContainText('Saturday at ten');
      await expect(guest.getByTestId('document-view-only')).toBeVisible();
      // Nothing that edits.
      await expect(guest.getByTestId('slides-toolbar')).toHaveCount(0);
      await expect(guest.getByTestId('speaker-notes')).toHaveCount(0);
      await expect(guest.getByTestId('document-delete')).toHaveCount(0);
      await elements(guest, 'text').first().click();
      await expect(sheet(guest).locator('.ProseMirror')).toHaveCount(0);
      await expect(sheet(guest).getByTestId('selection-frame')).toHaveCount(0);
      await guest.keyboard.press('Delete');
      await guest.keyboard.type('x');
      await expect(elements(guest, 'text')).toHaveCount(2);
      await shot(guest, 'view-01-guest');

      // Arrow keys and the strip walk through the slides.
      await guest.keyboard.press('ArrowDown');
      await expect(sheet(guest)).toContainText('Good shoes');
      await expect.poll(() => elements(guest, 'image').locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
      await shot(guest, 'view-02-guest-second');
      await thumbs(guest).nth(2).click();
      await expect(sheet(guest)).toContainText('See you there');
      await guest.keyboard.press('ArrowUp');

      // Presenting from the link, starting where the viewer was.
      await guest.getByTestId('present').click();
      const present = guest.getByTestId('present-view');
      await expect(present).toHaveAttribute('data-slide-index', '1');
      await expect(present).toContainText('Something warm');
      await guest.keyboard.press('PageDown');
      await expect(present).toContainText('See you there');
      await guest.getByTestId('present-exit').click();
      await expect(present).toHaveCount(0);
      await expect(sheet(guest)).toContainText('See you there');
    } finally {
      await guestContext.close();
    }

    // And on a phone, by touch.
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    try {
      const phone = await phoneContext.newPage();
      await prepareFreshSession(phone, relayUrl);
      await phone.goto(`${new URL(phone.url()).origin}/#${sharedUrl.split('#')[1]}`);
      // The slides are one under the other, each as wide as the screen.
      const stacked = phone.getByTestId('stack-slide');
      await expect(stacked).toHaveCount(3, { timeout: 60_000 });
      await expect(stacked.first()).toContainText('Saturday at ten');
      const slideBox = (await stacked.first().boundingBox())!;
      expect(slideBox.x).toBeGreaterThanOrEqual(0);
      expect(slideBox.x + slideBox.width).toBeLessThanOrEqual(390);
      expect(slideBox.width).toBeGreaterThan(340);
      await expect(phone.getByTestId('slides-toolbar')).toHaveCount(0);
      await shot(phone, 'view-03-phone');

      await phone.getByTestId('present').tap();
      const present = phone.getByTestId('present-view');
      await expect(present).toHaveAttribute('data-slide-index', '0');
      await shot(phone, 'view-04-phone-presenting');
      await swipe(phone, [320, 400], [60, 410]);
      await expect(present).toHaveAttribute('data-slide-index', '1');
      // A tap on the right goes on, on the left goes back.
      await phone.touchscreen.tap(330, 300);
      await expect(present).toHaveAttribute('data-slide-index', '2');
      await phone.touchscreen.tap(40, 300);
      await expect(present).toHaveAttribute('data-slide-index', '1');
      await swipe(phone, [60, 400], [320, 410]);
      await expect(present).toHaveAttribute('data-slide-index', '0');
      await phone.getByTestId('present-exit').tap();
      await expect(present).toHaveCount(0);

      // Turned on its side, the slide fills the screen when presenting.
      await phone.setViewportSize({ width: 760, height: 390 });
      await phone.getByTestId('present').tap();
      await expect(present).toBeVisible();
      const shown = (await present.locator('.slide-box').boundingBox())!;
      expect(Math.round(shown.height)).toBe(390);
      await shot(phone, 'view-05-phone-sideways');
    } finally {
      await phoneContext.close();
    }
  });

  test('a second tab shows edits at once, and undo leaves the other tab\'s work alone', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Together');
    await typeInBox(page, 0, 'Written in the first tab');
    await page.keyboard.press('Escape');
    await expectSlidesSaved(page);

    const second = await context.newPage();
    await second.goto(page.url());
    await expect(sheet(second)).toContainText('Written in the first tab', { timeout: 60_000 });
    await expect(second.getByTestId('document-save-status')).toHaveText('Open in another tab');

    // Each adds something; both show up in both.
    await typeInBox(second, 1, 'Subtitle from the second tab');
    await second.keyboard.press('Escape');
    await expect(sheet(page)).toContainText('Subtitle from the second tab', { timeout: 5_000 });
    await page.getByTestId('new-slide').click();
    await typeInBox(page, 0, 'A slide from the first tab');
    await page.keyboard.press('Escape');
    await expect(thumbs(second)).toHaveCount(2, { timeout: 5_000 });

    // The first tab moves the title while the second recolours it: both changes stay.
    await thumbs(page).first().click();
    await elements(page, 'text').first().click();
    await page.keyboard.press('Escape');
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('Shift+ArrowDown');
    await elements(second, 'text').first().click();
    await second.keyboard.press('Escape');
    await second.getByTestId('text-colour').click();
    await second.locator('[data-colour="#f2c94c"]').click();
    for (const tab of [page, second]) {
      const title = elements(tab, 'text').first();
      await expect(title.locator('.el-text')).toHaveCSS('color', 'rgb(242, 201, 76)');
      await expect(title).toHaveCSS('top', '220px');
    }

    // Undo in the first tab takes back its own move, not the other tab's colour.
    await page.getByRole('button', { name: 'Undo' }).click();
    for (const tab of [page, second]) {
      const title = elements(tab, 'text').first();
      await expect(title).toHaveCSS('top', '190px');
      await expect(title.locator('.el-text')).toHaveCSS('color', 'rgb(242, 201, 76)');
    }
    await expectSlidesSaved(page);

    // The first tab closes; the second takes over saving and a reload keeps everything.
    await page.close();
    await second.getByTestId('new-slide').click();
    await expectSlidesSaved(second);
    await second.reload({ waitUntil: 'domcontentloaded' });
    await expect(thumbs(second)).toHaveCount(3, { timeout: 60_000 });
    await expect(sheet(second)).toContainText('Subtitle from the second tab');
  });

  test('the editor follows a dark colour scheme and a narrow screen', async ({ page, relayUrl }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'After dark');
    await makeThreeSlides(page);
    await thumbs(page).nth(1).click();
    await elements(page, 'text').nth(1).click({ position: { x: 60, y: 24 } });
    await shot(page, 'view-06-dark-editing');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(sheet(page).getByTestId('selection-frame')).toHaveCount(0);
    await page.getByTestId('deck-theme').click();
    await expect(page.getByRole('dialog', { name: 'Themes' })).toBeVisible();
    await shot(page, 'view-07-dark-theme-menu');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Themes' })).toHaveCount(0);

    // Narrow, as on a phone: everything still reachable, the slide still whole.
    await page.setViewportSize({ width: 390, height: 760 });
    await expect(sheet(page)).toBeVisible();
    await expect.poll(async () => {
      const slideBox = (await sheet(page).boundingBox())!;
      return slideBox.x + slideBox.width;
    }).toBeLessThanOrEqual(390);
    await shot(page, 'view-08-dark-narrow');
    await typeInBox(page, 0, ' list');
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toContainText('Bring list');
    await shot(page, 'view-09-dark-narrow-selected');
  });
});
