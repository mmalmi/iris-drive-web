import { expect, test, type Browser, type BrowserContext, type Page } from './fixtures';
import { createDocument, createDriveProfile, documentBody, expectSaved, linkSecondDevice, prepareFreshSession, typeInDocument } from './documents.helpers';
import { activeCell, cellBox, clickCell, createSpreadsheet, expectCell, goTo, waitForGrid } from './sheets.helpers';
import { createPresentation, elements, sheet, thumbs, typeInBox } from './slides.helpers';

/**
 * Two people, each in a browser of their own, with one document open in a
 * shared folder: they see each other, where the other is, and what the other
 * types within about a second, sent live rather than by the saved files.
 */

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

/** The owner makes something and shares it for editing; a guest joins and has it open too. */
async function openTogether(
  page: Page,
  browser: Browser,
  relayUrl: string,
  make: (page: Page) => Promise<void>,
  path: RegExp,
): Promise<{ guest: Page; guestContext: BrowserContext }> {
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Owner');
  await make(page);
  await page.getByTestId('document-share').click();
  const link = await inviteLink(page);
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(path, { timeout: 30_000 });

  const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const guest = await guestContext.newPage();
  await prepareFreshSession(guest, relayUrl);
  await createDriveProfile(guest, 'Guest');
  await guest.goto(`${new URL(guest.url()).origin}/#${link.split('#')[1]}`);
  await expect(guest).toHaveURL(path, { timeout: 90_000 });
  return { guest, guestContext };
}

function avatar(page: Page, name: string) {
  return page.getByTestId('presence-avatar').and(page.locator(`[data-name="${name}"]`));
}

/** Points at someone in the header, then lists who is here and goes to where that person is. */
async function goToPerson(page: Page, name: string): Promise<void> {
  await avatar(page, name).hover();
  await expect(page.getByTestId('presence-tooltip')).toHaveText(name);
  await avatar(page, name).click();
  const person = page.getByTestId('presence-people').getByTestId('presence-person').and(page.locator(`[data-name="${name}"]`));
  await expect(person).toBeVisible();
  await person.getByTestId('presence-go').click();
  await expect(page.getByTestId('presence-people')).toHaveCount(0);
}

/** How many edits a page took in live. */
function liveEdits(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __liveEditsReceived?: number }).__liveEditsReceived ?? 0);
}

/**
 * Milliseconds from the end of `act` on one page until `arrived` holds on
 * the other, looked at every frame.
 */
async function latency(act: () => Promise<void>, to: Page, arrived: (arg: string) => boolean, arg: string): Promise<number> {
  await act();
  const start = Date.now();
  await to.waitForFunction(arrived, arg, { polling: 'raf', timeout: 2000 });
  return Date.now() - start;
}

const bodyHas = (words: string): boolean => document.querySelector('[data-testid="document-content"] .ProseMirror')?.textContent?.includes(words) ?? false;

test.describe('live collaboration', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('in a document: who is here, their cursor and selection, their typing within a second, and leaving', async ({ page, browser, relayUrl }, testInfo) => {
    const { guest, guestContext } = await openTogether(page, browser, relayUrl, async (owner) => {
      await createDocument(owner, 'Plan');
      await typeInDocument(owner, 'Owner wrote this first.');
      await expectSaved(owner);
    }, /\/main\/Plan\.irisdoc$/);
    try {
      await expect(documentBody(guest)).toContainText('Owner wrote this first.', { timeout: 90_000 });
      await expect(guest.getByTestId('document-toolbar')).toBeVisible({ timeout: 30_000 });

      // Each sees the other in the header, under the name the folder gives them.
      await expect(avatar(page, 'Guest')).toBeVisible({ timeout: 15_000 });
      await expect(avatar(guest, 'Owner')).toBeVisible({ timeout: 15_000 });
      await expect(avatar(page, 'Guest')).toHaveText('G');

      // The guest's cursor and selection show for the owner, in the guest's colour and with the name.
      await documentBody(guest).click();
      await guest.keyboard.press('ControlOrMeta+End');
      await guest.keyboard.down('Shift');
      for (let step = 0; step < 5; step += 1) await guest.keyboard.press('ArrowLeft');
      await guest.keyboard.up('Shift');
      const caret = page.locator('.collaboration-carets__caret');
      await expect(caret).toHaveCount(1, { timeout: 5000 });
      await expect(caret).toHaveAttribute('data-name', 'Guest');
      // The name is drawn on the caret, not written into the text.
      await expect(documentBody(page)).not.toContainText('Guest');
      const shownText = async (on: Page) => (await documentBody(on).innerText()).replace(/\s+/g, ' ').trim();
      expect(await shownText(page)).toBe(await shownText(guest));
      await expect(page.locator('.ProseMirror-yjs-selection')).toContainText('irst.');
      await page.screenshot({ path: testInfo.outputPath('owner-sees-guest.png') });

      // What the guest types reaches the owner within two seconds, live, not by the files.
      await guest.keyboard.press('End');
      const before = await liveEdits(page);
      const typed = await latency(() => guest.keyboard.type(' Guest typing live.'), page, bodyHas, 'Guest typing live.');
      console.log(`[live] document edit reached the other browser after ${typed} ms`);
      expect(typed).toBeLessThan(2000);
      expect(await liveEdits(page)).toBeGreaterThan(before);
      // And the other way.
      await documentBody(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      const back = await latency(() => page.keyboard.type(' Owner answers.'), guest, bodyHas, 'Owner answers.');
      console.log(`[live] document edit came back after ${back} ms`);
      expect(back).toBeLessThan(2000);
      await expectSaved(guest);
      await expectSaved(page);

      // Pointing at the guest names them at once; a click lists who is here, with a way to their page.
      await avatar(page, 'Guest').hover();
      await expect(page.getByTestId('presence-tooltip')).toHaveText('Guest');
      await page.screenshot({ path: testInfo.outputPath('owner-points-at-guest.png') });
      await avatar(page, 'Guest').click();
      const people = page.getByTestId('presence-people');
      await expect(people).toBeVisible();
      await expect(people.getByTestId('presence-person')).toHaveCount(1);
      await expect(people.getByTestId('presence-person')).toHaveAttribute('data-name', 'Guest');
      const profile = people.getByTestId('presence-person-link');
      if (await profile.count() > 0) await expect(profile).toHaveAttribute('href', /^#\/npub1[0-9a-z]+\/profile$/);
      await page.screenshot({ path: testInfo.outputPath('owner-lists-people.png') });
      // Escape closes the list and gives the keyboard back to the face that opened it; Enter opens it again.
      await page.keyboard.press('Escape');
      await expect(people).toHaveCount(0);
      await expect(avatar(page, 'Guest')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(people).toBeVisible();
      await page.keyboard.press('Escape');

      // "Go to" brings the guest's place into view, wherever the owner had scrolled.
      await documentBody(guest).click();
      await guest.keyboard.press('ControlOrMeta+End');
      for (let line = 0; line < 40; line += 1) await guest.keyboard.press('Enter');
      await guest.keyboard.type('Far down the page.');
      await expect(documentBody(page)).toContainText('Far down the page.', { timeout: 5000 });
      await page.evaluate(() => {
        for (let node = document.querySelector('.ProseMirror')?.parentElement; node; node = node.parentElement) node.scrollTop = 0;
      });
      await expect(caret).not.toBeInViewport();
      await goToPerson(page, 'Guest');
      await expect(caret).toBeInViewport();

      // On a phone the faces collapse to how many there are; a tap lists them from the bottom of the screen.
      await page.setViewportSize({ width: 390, height: 800 });
      await expect(page.getByTestId('presence-count')).toBeVisible();
      await expect(page.getByTestId('presence-count')).toHaveText('G1');
      await expect(avatar(page, 'Guest')).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath('owner-phone.png') });
      await page.getByTestId('presence-count').click();
      await expect(people).toHaveAttribute('data-sheet', 'true');
      await expect(people.getByTestId('presence-person')).toHaveAttribute('data-name', 'Guest');
      await page.screenshot({ path: testInfo.outputPath('owner-phone-people.png') });
      await page.keyboard.press('Escape');
      await expect(people).toHaveCount(0);
      await expect(page.getByTestId('presence-count')).toBeFocused();
      await page.setViewportSize({ width: 1280, height: 720 });

      // The guest goes back to the folder: the owner no longer sees them, at once.
      await guest.getByRole('link', { name: 'Back to folder' }).click();
      await expect(avatar(page, 'Guest')).toHaveCount(0, { timeout: 3000 });
      await expect(caret).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('in a spreadsheet: who is here, their selected cells, and their typing within a second', async ({ page, browser, relayUrl }, testInfo) => {
    const { guest, guestContext } = await openTogether(page, browser, relayUrl, async (owner) => {
      await createSpreadsheet(owner, 'Budget');
      await clickCell(owner, 'A1');
      await owner.keyboard.type('Item');
      await owner.keyboard.press('Enter');
      await expectSaved(owner);
    }, /\/main\/Budget\.irissheet$/);
    try {
      await waitForGrid(guest);
      await expectCell(guest, 'A1', 'Item');
      await expect(avatar(page, 'Guest')).toBeVisible({ timeout: 15_000 });
      await expect(avatar(guest, 'Owner')).toBeVisible({ timeout: 15_000 });

      // The guest selects B2:C4; the owner sees those cells outlined with the guest's name.
      await clickCell(guest, 'B2');
      await clickCell(guest, 'C4', { shift: true });
      const outline = page.getByTestId('sheet-presence').and(page.locator('[data-name="Guest"]'));
      await expect(outline).toBeVisible({ timeout: 5000 });
      await expect(guest.getByTestId('sheet-active-cell')).toHaveAttribute('data-cell', 'B2:C4');
      const [b2, c4] = await Promise.all([cellBox(page, 'B2'), cellBox(page, 'C4')]);
      const expected = [b2.x, b2.y, c4.x + c4.width, c4.y + c4.height].map(Math.round);
      await expect.poll(async () => {
        const box = await outline.boundingBox();
        return box ? [box.x, box.y, box.x + box.width, box.y + box.height].map(Math.round) : null;
      }, { timeout: 2000 }).toEqual(expected);
      await expect(outline.locator('[data-label]')).toHaveAttribute('data-label', 'Guest');
      await page.screenshot({ path: testInfo.outputPath('owner-sees-guest-cells.png') });

      // What the guest types into a cell reaches the owner within two seconds.
      await clickCell(guest, 'A2');
      await guest.keyboard.type('Rent');
      const before = await liveEdits(page);
      const typed = await latency(() => guest.keyboard.press('Enter'), page,
        words => (window as unknown as { __sheet?: { text(row: number, col: number): string } }).__sheet?.text(1, 0) === words, 'Rent');
      console.log(`[live] spreadsheet edit reached the other browser after ${typed} ms`);
      expect(typed).toBeLessThan(2000);
      expect(await liveEdits(page)).toBeGreaterThan(before);
      await expectCell(page, 'A2', 'Rent');
      // The outline follows the guest to the next cell.
      const a3 = await cellBox(page, 'A3');
      await expect.poll(async () => Math.round((await outline.boundingBox())?.y ?? 0), { timeout: 5000 }).toBeGreaterThanOrEqual(Math.round(a3.y) - 3);

      // The guest goes far down and right; "Go to" shows the owner those cells and leaves the owner's own selection alone.
      await goTo(guest, 'Z80');
      const mine = await activeCell(page).getAttribute('data-cell');
      await expect(outline).not.toBeInViewport({ timeout: 5000 });
      await goToPerson(page, 'Guest');
      await expect(outline).toBeInViewport();
      await expect(activeCell(page)).toHaveAttribute('data-cell', mine!);
      await page.screenshot({ path: testInfo.outputPath('owner-went-to-guest-cells.png') });

      // The guest's browser closes without a word: they go once nothing more is heard.
      await guestContext.close();
      await expect(avatar(page, 'Guest')).toHaveCount(0, { timeout: 10_000 });
      await expect(outline).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });

  test('in a presentation: who is here, their slide and selected element, and their typing within a second', async ({ page, browser, relayUrl }, testInfo) => {
    const { guest, guestContext } = await openTogether(page, browser, relayUrl, async (owner) => {
      await createPresentation(owner, 'Pitch');
      await typeInBox(owner, 0, 'Title');
      await owner.keyboard.press('Escape');
      await expectSaved(owner);
    }, /\/main\/Pitch\.irisslides$/);
    try {
      await expect(sheet(guest)).toContainText('Title', { timeout: 90_000 });
      await expect(guest.getByTestId('slides-toolbar')).toBeVisible({ timeout: 30_000 });
      await expect(avatar(page, 'Guest')).toBeVisible({ timeout: 15_000 });
      await expect(avatar(guest, 'Owner')).toBeVisible({ timeout: 15_000 });

      // The owner's slide strip shows the guest on the slide they have open.
      const onSlide = thumbs(page).first().getByTestId('slide-thumb-presence').locator('[data-name="Guest"]');
      await expect(onSlide).toBeVisible({ timeout: 5000 });

      // The guest selects the title; the owner sees it outlined with the guest's name.
      await elements(guest, 'text').first().click();
      const outline = page.getByTestId('slide-presence').and(page.locator('[data-name="Guest"]'));
      await expect(outline).toBeVisible({ timeout: 5000 });
      await expect(outline).toHaveAttribute('data-element', (await elements(page, 'text').first().getAttribute('data-el'))!);
      await page.screenshot({ path: testInfo.outputPath('owner-sees-guest-element.png') });

      // What the guest types into the title reaches the owner within two seconds.
      await guest.keyboard.press('End');
      const before = await liveEdits(page);
      const typed = await latency(() => guest.keyboard.type(' live'), page,
        words => document.querySelector('[data-testid="slide-sheet"]')?.textContent?.includes(words) ?? false, 'Title live');
      console.log(`[live] slide edit reached the other browser after ${typed} ms`);
      expect(typed).toBeLessThan(2000);
      expect(await liveEdits(page)).toBeGreaterThan(before);

      // A new slide the guest adds and moves to shows there.
      await guest.keyboard.press('Escape');
      await guest.getByTestId('new-slide').click();
      await expect(thumbs(page)).toHaveCount(2, { timeout: 2000 });
      await expect(thumbs(page).nth(1).getByTestId('slide-thumb-presence').locator('[data-name="Guest"]')).toBeVisible({ timeout: 5000 });
      await expect(onSlide).toHaveCount(0);

      // "Go to" opens the slide the guest is on.
      await expect(thumbs(page).first()).toHaveClass(/current/);
      await goToPerson(page, 'Guest');
      await expect(thumbs(page).nth(1)).toHaveClass(/current/);

      await guest.goto('about:blank');
      await expect(avatar(page, 'Guest')).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('another device of the same account shows its cursor as "You", not as someone else', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Owner');
    const deviceContext = await browser.newContext();
    try {
      const device = await deviceContext.newPage();
      await linkSecondDevice(page, device, relayUrl, profileId);
      await page.goto(`/#/${profileId}/main`);
      await createDocument(page, 'Notes');
      await typeInDocument(page, 'From the first device.');
      await expectSaved(page);
      await device.goto(page.url());
      await expect(documentBody(device)).toContainText('From the first device.', { timeout: 90_000 });

      await documentBody(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      const caret = device.locator('.collaboration-carets__caret');
      await expect(caret).toHaveCount(1, { timeout: 15_000 });
      await expect(caret).toHaveAttribute('data-name', 'You');
      // One's own devices are not someone else in the header.
      await expect(device.getByTestId('presence-avatar')).toHaveCount(0);
    } finally {
      await deviceContext.close();
    }
  });

  test('someone removed from the shared folder stops seeing presence and live edits', async ({ page, browser, relayUrl }) => {
    const { guest, guestContext } = await openTogether(page, browser, relayUrl, async (owner) => {
      await createDocument(owner, 'Minutes');
      await typeInDocument(owner, 'Agenda.');
      await expectSaved(owner);
    }, /\/main\/Minutes\.irisdoc$/);
    try {
      await expect(documentBody(guest)).toContainText('Agenda.', { timeout: 90_000 });
      await expect(avatar(page, 'Guest')).toBeVisible({ timeout: 15_000 });
      await expect(avatar(guest, 'Owner')).toBeVisible({ timeout: 15_000 });
      await documentBody(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await latency(() => page.keyboard.type(' Before.'), guest, bodyHas, 'Before.');

      // The owner removes the guest: a new key epoch the guest cannot open.
      await page.getByTestId('document-share').click();
      await page.getByTestId('share-people-remove').click();
      await expect(page.getByTestId('share-people-member')).toHaveCount(1, { timeout: 30_000 });
      await page.keyboard.press('Escape');
      // The owner stops showing the guest at once.
      await expect(avatar(page, 'Guest')).toHaveCount(0, { timeout: 5000 });

      const received = await liveEdits(guest);
      await documentBody(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(' After removal.');
      await expectSaved(page);
      await page.waitForTimeout(6000);
      await expect(documentBody(guest)).not.toContainText('After removal.');
      expect(await liveEdits(guest)).toBe(received);
      // Nothing more is heard from the owner, so the guest stops showing them too.
      await expect(avatar(guest, 'Owner')).toHaveCount(0, { timeout: 20_000 });
      // What the guest types is not taken in by the owner either.
      const ownerReceived = await liveEdits(page);
      await typeInDocument(guest, ' Still here?');
      await page.waitForTimeout(3000);
      await expect(documentBody(page)).not.toContainText('Still here?');
      expect(await liveEdits(page)).toBe(ownerReceived);
    } finally {
      await guestContext.close();
    }
  });
});
