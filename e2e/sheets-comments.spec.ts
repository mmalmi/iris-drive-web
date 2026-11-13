import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { flushPendingPublishes } from './test-utils';
import { cellBox, clickCell, createSpreadsheet, expectCell, expectSaved, goTo, shotPath, tapCell, touchPath, typeTable, waitForGrid } from './sheets.helpers';

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

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

async function comment(page: Page, cell: string, text: string): Promise<void> {
  await clickCell(page, cell, { button: 'right' });
  await page.getByTestId('menu-comment').click();
  await page.getByTestId('comment-new').fill(text);
  await page.getByTestId('comment-send').click();
}

test.describe('comments on cells', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('two people talk about a cell, resolve it, and a reader sees the talk', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Ada');
    await createSpreadsheet(page, 'Trip');
    await typeTable(page, 'A1', [['Item', 'Cost'], ['Hotel', '420'], ['Train', '96']]);
    await comment(page, 'B2', 'Is this per night?');
    await expect(page.getByTestId('comment-card')).toContainText('Is this per night?');
    await expect(page.getByTestId('sheet-comment-count')).toHaveText('1');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('comment-card')).toHaveCount(0);
    await expectSaved(page);

    // Shared for editing with a second account.
    await page.getByTestId('access-badge').click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/main\/Trip\.irissheet$/, { timeout: 30_000 });
    await waitForGrid(page);

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await createDriveProfile(guest, 'Bob');
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest).toHaveURL(/\/main\/Trip\.irissheet$/, { timeout: 90_000 });
      await waitForGrid(guest);
      await expectCell(guest, 'B2', '420');
      await expect(guest.getByTestId('sheet-comment-count')).toHaveText('1', { timeout: 60_000 });
      await clickCell(guest, 'B2');
      const card = guest.getByTestId('comment-card');
      await expect(card).toContainText('Is this per night?');
      await expect(card).toContainText('Ada');
      await card.getByTestId('comment-reply').fill('No, for three nights.');
      await card.getByTestId('comment-send-reply').click();
      await expect(card.getByTestId('comment-message')).toHaveCount(2);
      await guest.screenshot({ path: shotPath(testInfo, 'comments-guest.png') });
      await expectSaved(guest);

      // The answer reaches Ada, who resolves the thread.
      await clickCell(page, 'A5');
      await clickCell(page, 'B2');
      await expect(page.getByTestId('comment-card').getByTestId('comment-message')).toHaveCount(2, { timeout: 90_000 });
      await expect(page.getByTestId('comment-card')).toContainText('Bob');
      await page.screenshot({ path: shotPath(testInfo, 'comments-owner.png') });
      await page.getByTestId('comment-card').getByTestId('comment-resolve').click();
      await expect(page.getByTestId('comment-card')).toHaveCount(0);
      await expect(page.getByTestId('sheet-comment-count')).toHaveCount(0);
      await expectSaved(page);
      await expect(guest.getByTestId('sheet-comment-count')).toHaveCount(0, { timeout: 90_000 });
    } finally {
      await guestContext.close();
    }

    // A read-only link shows the talk, with no way to write.
    await flushPendingPublishes(page);
    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-tab-link').click();
    await page.getByTestId('share-copy-url').click();
    const snapshot = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');
    const readerContext = await browser.newContext();
    try {
      const reader = await readerContext.newPage();
      await prepareFreshSession(reader, relayUrl);
      await reader.goto(onThisOrigin(reader, snapshot));
      await waitForGrid(reader);
      await expect(reader.getByTestId('document-view-only')).toBeVisible();
      await reader.getByTestId('sheet-comments').click();
      const panel = reader.getByTestId('comments-panel');
      await expect(panel).toContainText('No open comments.');
      await panel.getByTestId('comments-show-resolved').check();
      await expect(panel.getByTestId('comment-message')).toHaveCount(2);
      await expect(panel).toContainText('No, for three nights.');
      await expect(panel.getByTestId('comment-reply')).toHaveCount(0);
      await expect(panel.getByTestId('comment-reopen')).toHaveCount(0);
      await reader.screenshot({ path: shotPath(testInfo, 'comments-reader.png') });
    } finally {
      await readerContext.close();
    }
  });
});

test.describe('comments and charts on a phone', () => {
  test.setTimeout(240_000);
  test.use({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test('a chart fits below the table, and a comment shows along the bottom', async ({ page, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createSpreadsheet(page, 'Pocket');
    await typeTable(page, 'A1', [['Day', 'Steps'], ['Mon', '6200'], ['Tue', '8100'], ['Wed', '4300']]);
    await goTo(page, 'A1');
    await page.getByTestId('sheet-insert').tap();
    await page.getByTestId('insert-chart').tap();
    await expect(page.getByTestId('sheet-chart')).toBeVisible();
    await expect(page.getByTestId('chart-panel')).toBeVisible();
    // As wide as the screen allows, below the cells, and in view above the settings.
    const chartBox = await page.getByTestId('sheet-chart').boundingBox();
    const panelBox = await page.getByTestId('chart-panel').boundingBox();
    expect(chartBox && chartBox.x + chartBox.width).toBeLessThanOrEqual(390);
    // Its top, title and most of it stay in view above the settings.
    expect((chartBox?.y ?? 999) + 120).toBeLessThanOrEqual(panelBox?.y ?? 0);
    await page.screenshot({ path: shotPath(testInfo, 'phone-chart-panel.png') });
    await page.getByTestId('side-panel-close').tap();
    await goTo(page, 'B3');

    // A long press on a cell, then Comment.
    const b3 = await cellBox(page, 'B3');
    await touchPath(page, [{ x: b3.x + b3.width / 2, y: b3.y + b3.height / 2 }], 700);
    await page.getByTestId('menu-comment').tap();
    await page.getByTestId('comment-new').fill('Rest day?');
    await page.getByTestId('comment-send').tap();
    await expect(page.getByTestId('comment-card')).toContainText('Rest day?');
    await page.screenshot({ path: shotPath(testInfo, 'phone-comment.png') });
    await page.getByTestId('comment-card').getByRole('button', { name: 'Close comments' }).tap();
    await tapCell(page, 'A4');
    await tapCell(page, 'B3');
    await expect(page.getByTestId('comment-card')).toContainText('Rest day?');
  });
});
