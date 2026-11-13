import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import {
  addShapeAt,
  bandsSvg,
  createPresentation,
  elements,
  expectSlidesSaved,
  sheet,
  shot,
  thumbs,
} from './slides.helpers';

/** Three slides, each with notes for the one presenting. */
async function makeTalk(page: Page): Promise<void> {
  await page.keyboard.type('Harbour walk');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Saturday at ten');
  await page.keyboard.press('Escape');
  await page.getByTestId('speaker-notes').fill('Welcome everyone.\nSay who is leading the walk.');
  await page.keyboard.press('ControlOrMeta+m');
  await page.keyboard.type('Bring');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Good shoes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Something warm');
  await page.keyboard.press('Escape');
  await page.getByTestId('slides-image-input').setInputFiles({ name: 'bands.svg', mimeType: 'image/svg+xml', buffer: bandsSvg(360, 220) });
  await expect(elements(page, 'image')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('speaker-notes').fill('Mention the forecast.');
  await page.keyboard.press('ControlOrMeta+m');
  await page.getByTestId('slide-layout').click();
  await page.getByTestId('relayout-section').click();
  await page.keyboard.type('See you there');
  await page.keyboard.press('Escape');
  await expect(thumbs(page)).toHaveCount(3);
  await thumbs(page).first().click();
}

async function touchDrag(page: Page, from: [number, number], to: [number, number], hold: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, id: 1 });
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(...from)] });
  if (hold) await page.waitForTimeout(hold);
  for (let step = 1; step <= 8; step += 1) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(from[0] + (to[0] - from[0]) * step / 8, from[1] + (to[1] - from[1]) * step / 8)],
    });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test.describe('giving and handing out a presentation', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('the presenter has a window of their own, with notes and the time, in step with what the audience sees', async ({ page, context, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Harbour walk');
    await makeTalk(page);
    await expectSlidesSaved(page);

    await page.getByTestId('slides-more').click();
    await shot(page, 'present-01-more-menu');
    const opening = context.waitForEvent('page');
    await page.getByTestId('present-with-notes').click();
    const presenter = await opening;
    const audience = page.getByTestId('present-view');
    await expect(audience).toHaveAttribute('data-slide-index', '0');

    // The presenter's window: this slide, the next one, the notes, a clock and a running timer.
    const view = presenter.getByTestId('presenter-view');
    await expect(view).toBeVisible({ timeout: 60_000 });
    await expect(view).toHaveAttribute('data-slide-index', '0');
    await expect(presenter.getByTestId('presenter-current')).toContainText('Harbour walk');
    await expect(presenter.getByTestId('presenter-next')).toContainText('Good shoes');
    await expect(presenter.getByTestId('presenter-notes')).toHaveText('Welcome everyone.\nSay who is leading the walk.');
    await expect(presenter.getByTestId('presenter-clock')).toHaveText(/^\d{1,2}[:.]\d{2}/);
    await expect(presenter.getByTestId('presenter-timer')).toHaveText(/0:0[1-9]/, { timeout: 15_000 });
    await expect(presenter.getByTestId('presenter-count')).toHaveText('1 / 3');
    await presenter.setViewportSize({ width: 1180, height: 720 });
    await shot(presenter, 'present-02-presenter-window');

    // Moving on in the presenter's window moves the audience's, by key or by button.
    await presenter.keyboard.press('n');
    await expect(audience).toHaveAttribute('data-slide-index', '1');
    await expect(audience).toContainText('Something warm');
    await expect(presenter.getByTestId('presenter-notes')).toHaveText('Mention the forecast.');
    await expect(presenter.getByTestId('presenter-next')).toContainText('See you there');
    await presenter.getByTestId('presenter-previous').click();
    await expect(audience).toHaveAttribute('data-slide-index', '0');
    await presenter.keyboard.press('ArrowRight');
    await expect(audience).toHaveAttribute('data-slide-index', '1');

    // And the other way round.
    await page.keyboard.press('ArrowRight');
    await expect(view).toHaveAttribute('data-slide-index', '2');
    await expect(presenter.getByTestId('presenter-notes')).toHaveText('No notes for this slide');
    await expect(presenter.getByTestId('presenter-next')).toHaveText('Last slide');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('present-end')).toBeVisible();
    await expect(view).toHaveAttribute('data-slide-index', '-1');
    await presenter.keyboard.press('p');
    await expect(audience).toHaveAttribute('data-slide-index', '2');
    await presenter.keyboard.press('Home');
    await expect(audience).toHaveAttribute('data-slide-index', '0');

    // The timer starts again when asked.
    await expect(presenter.getByTestId('presenter-timer')).not.toHaveText(/0:00/);
    await presenter.getByTestId('presenter-timer').click();
    await expect(presenter.getByTestId('presenter-timer')).toHaveText(/0:00/);

    // Notes changed while presenting show at once; ending is said in the presenter's window.
    await page.keyboard.press('Escape');
    await expect(audience).toHaveCount(0);
    await expect(presenter.getByTestId('presenter-over')).toBeVisible();
    await page.getByTestId('speaker-notes').fill('Welcome everyone. Start on time.');
    await expect(presenter.getByTestId('presenter-notes')).toHaveText('Welcome everyone. Start on time.');
    // The presenter's window alone still walks through the deck.
    await presenter.getByTestId('presenter-forward').click();
    await expect(view).toHaveAttribute('data-slide-index', '1');
    await expect(presenter.getByTestId('presenter-over')).toHaveCount(0);
    await presenter.setViewportSize({ width: 390, height: 760 });
    await shot(presenter, 'present-03-presenter-narrow');
    await presenter.close();
    // Nothing the presenter's window did changed the deck.
    await expect(thumbs(page)).toHaveCount(3);

    // Someone with a view-only link can present with notes too, and read them.
    await expectSlidesSaved(page);
    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');
    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(`${new URL(guest.url()).origin}/#${sharedUrl.split('#')[1]}`);
      await expect(thumbs(guest)).toHaveCount(3, { timeout: 60_000 });
      await guest.getByTestId('slides-more').click();
      const guestOpening = guestContext.waitForEvent('page');
      await guest.getByTestId('present-with-notes').click();
      const guestPresenter = await guestOpening;
      await expect(guestPresenter.getByTestId('presenter-notes')).toHaveText('Welcome everyone. Start on time.', { timeout: 60_000 });
      await guest.keyboard.press('ArrowRight');
      await expect(guestPresenter.getByTestId('presenter-notes')).toHaveText('Mention the forecast.');
      await expect(guestPresenter.getByTestId('presenter-view')).toHaveAttribute('data-slide-index', '1');
    } finally {
      await guestContext.close();
    }
  });

  test('the deck prints one slide to a page, and that is how it becomes a PDF', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Handout');
    await makeTalk(page);
    await page.getByTestId('deck-theme').click();
    await page.getByTestId('theme-ocean').click();

    // The browser's print window cannot be driven from here; stand in for it and print by hand below.
    await page.evaluate(() => {
      (window as unknown as { printed: number }).printed = 0;
      window.print = () => {
        (window as unknown as { printed: number }).printed += 1;
      };
    });
    await page.getByTestId('slides-more').click();
    await page.getByTestId('slides-print-button').click();
    const pages = page.locator('[data-testid="slides-print"] .slides-print-page');
    await expect(pages).toHaveCount(3);
    await expect.poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
    // On screen nothing changes while the print window is up.
    await expect(sheet(page)).toBeVisible();

    // What the printer gets: the slides only, in their colours, text fitted as on screen.
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('slides-toolbar')).toBeHidden();
    await expect(pages.first()).toBeVisible();
    await expect(pages.nth(1)).toContainText('Something warm');
    await expect(pages.first().locator('.slide-surface')).not.toHaveCSS('background-image', 'none');
    const size = await pages.nth(1).evaluate(node => ({ width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight }));
    expect(size).toEqual({ width: 1280, height: 720 });
    await page.setViewportSize({ width: 1280, height: 2160 });
    await shot(page, 'print-01-pages');
    await page.emulateMedia({ media: null });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.getByTestId('slides-toolbar')).toBeVisible();

    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: false });
    const text = pdf.toString('latin1');
    expect(text.match(/\/Type\s*\/Page(?![s])/g)).toHaveLength(3);
    // A slide is 13.33 by 7.5 inches: 960 by 540 points.
    expect(text).toMatch(/\/MediaBox\s*\[\s*0\s+0\s+960\s+540\s*\]/);
    if (process.env.SLIDES_SHOTS) fs.writeFileSync(path.join(process.env.SLIDES_SHOTS, 'handout.pdf'), pdf);

    // When printing is over the pages are put away, and with them the rules that shaped the print.
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.getByTestId('slides-print')).toHaveCount(0);
    const leftover = await page.evaluate(() => [...document.querySelectorAll('style')].some(style => style.textContent?.includes('slides-print-page')));
    expect(leftover).toBe(false);
  });

  test('on a phone: reading is a stack of slides, and a held finger reorders them when editing', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Pocket');
    await makeTalk(page);
    await expectSlidesSaved(page);
    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');

    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    try {
      const phone = await phoneContext.newPage();
      await prepareFreshSession(phone, relayUrl);
      await phone.goto(`${new URL(phone.url()).origin}/#${sharedUrl.split('#')[1]}`);
      const stack = phone.getByTestId('slide-stack');
      const slides = phone.getByTestId('stack-slide');
      await expect(slides).toHaveCount(3, { timeout: 60_000 });
      await expect(slides.first()).toContainText('Harbour walk');
      // Each slide is as wide as the screen allows, and the rest are a scroll away.
      const first = (await slides.first().boundingBox())!;
      expect(first.width).toBeGreaterThan(350);
      await expect.poll(() => stack.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await shot(phone, 'phone-01-stack');
      await slides.nth(2).scrollIntoViewIfNeeded();
      await shot(phone, 'phone-02-stack-scrolled');

      // A tap presents from that slide.
      await slides.nth(1).tap();
      const present = phone.getByTestId('present-view');
      await expect(present).toHaveAttribute('data-slide-index', '1');
      await phone.getByTestId('present-exit').tap();
      await expect(present).toHaveCount(0);
      await expect(slides).toHaveCount(3);
    } finally {
      await phoneContext.close();
    }

    // The owner on a phone: the strip along the bottom; a finger held on a slide picks it up.
    const ownerPhone = await browser.newContext({
      viewport: { width: 390, height: 760 },
      hasTouch: true,
      isMobile: true,
      storageState: await page.context().storageState({ indexedDB: true }),
    });
    try {
      const phone = await ownerPhone.newPage();
      await phone.goto(page.url());
      await expect(thumbs(phone)).toHaveCount(3, { timeout: 60_000 });
      await expect(phone.getByTestId('slides-toolbar')).toBeVisible();
      const titles = () => thumbs(phone).evaluateAll(nodes => nodes.map(node => node.querySelector('[data-el]')?.textContent?.trim()));
      expect(await titles()).toEqual(['Harbour walk', 'Bring', 'See you there']);
      const last = (await thumbs(phone).nth(2).boundingBox())!;
      const firstThumb = (await thumbs(phone).nth(0).boundingBox())!;
      // A quick swipe along the strip scrolls it and moves nothing.
      await touchDrag(phone, [last.x + last.width / 2, last.y + last.height / 2], [firstThumb.x + 10, firstThumb.y + firstThumb.height / 2], 0);
      expect(await titles()).toEqual(['Harbour walk', 'Bring', 'See you there']);
      // Held first, the slide comes along and is dropped in front.
      await touchDrag(phone, [last.x + last.width / 2, last.y + last.height / 2], [firstThumb.x + 10, firstThumb.y + firstThumb.height / 2], 500);
      expect(await titles()).toEqual(['See you there', 'Harbour walk', 'Bring']);
      await shot(phone, 'phone-03-owner-reordered');
      // A shape dropped by a tap, with the tool from the toolbar.
      await addShapeAt(phone, 'ellipse', 900, 500);
      await expect(elements(phone, 'shape')).toHaveCount(1);
    } finally {
      await ownerPhone.close();
    }
  });
});
