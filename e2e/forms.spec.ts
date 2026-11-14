import { expect, test, type Browser, type Page } from './fixtures';
import { chooseNew } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';

/**
 * Forms: made in Drive, sent by link, answered by people with no account or
 * as themselves, and the answers reach only the form's maker.
 */

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

async function createForm(page: Page, title: string): Promise<void> {
  await chooseNew(page, 'Form');
  await page.getByPlaceholder('Form name...').fill(title);
  await page.getByPlaceholder('Form name...').press('Enter');
  await expect(page.getByTestId('document-title')).toHaveText(title, { timeout: 30_000 });
  await expect(page.getByTestId('question-card')).toHaveCount(1, { timeout: 30_000 });
}

/** Opens Send, takes the form's link and closes it again. */
async function sendLink(page: Page, who: 'anyone' | 'network' = 'anyone'): Promise<string> {
  await page.getByTestId('form-send').click();
  await page.getByTestId(`form-who-${who}`).check();
  await expect(page.getByTestId('form-link')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('form-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/.+\.irisform\?k=[0-9a-f]+$/);
  await page.keyboard.press('Escape');
  return link;
}

/** Opens the form's link in `page` until its questions show, reloading while its newest version is on the way. */
async function openForm(page: Page, link: string, question: string): Promise<void> {
  await page.goto(onThisOrigin(page, link));
  const shown = page.getByTestId('form-fill').getByText(question, { exact: true }).first();
  try {
    await expect(shown).toBeVisible({ timeout: 15_000 });
  } catch {
    await expect(async () => {
      await page.reload();
      await expect(shown).toBeVisible({ timeout: 8_000 });
    }).toPass({ timeout: 90_000 });
  }
}

async function newVisitor(browser: Browser, relayUrl: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await prepareFreshSession(page, relayUrl);
  return { page, close: () => context.close() };
}

async function pubkeyOf(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __nostrStore: { getState: () => { pubkey: string } } }).__nostrStore.getState().pubkey);
}

test.describe('forms', () => {
  test.setTimeout(300_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('someone with the link answers without an account, and only the maker sees it', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await createForm(page, 'Party');

    // A choice question that must be answered, and a short one.
    const first = page.getByTestId('question-card').first();
    await first.getByTestId('question-title').fill('Coming?');
    await first.getByTestId('question-option').first().fill('Yes');
    await first.getByTestId('question-add-option').click();
    await first.getByTestId('question-option').nth(1).fill('No');
    await first.getByTestId('question-required').check();
    await page.getByTestId('form-add-question').click();
    const second = page.getByTestId('question-card').nth(1);
    await expect(second.getByTestId('question-title')).toBeFocused();
    await second.getByTestId('question-type').selectOption('short');
    await second.getByTestId('question-title').fill('Your name');
    await page.getByTestId('form-description').fill('Saturday at eight');
    await page.screenshot({ path: testInfo.outputPath('editor.png') });

    const link = await sendLink(page);
    await page.getByTestId('form-tab-responses').click();
    await expect(page.getByTestId('form-results-empty')).toBeVisible({ timeout: 30_000 });

    const guest = await newVisitor(browser, relayUrl);
    try {
      await openForm(guest.page, link, 'Coming?');
      const fill = guest.page.getByTestId('form-fill');
      await expect(fill.getByText('Saturday at eight')).toBeVisible();
      await expect(guest.page.getByTestId('drive-setup')).toHaveCount(0);
      // The answers are not part of what the link opens.
      await expect(guest.page.getByTestId('form-results')).toHaveCount(0);
      await expect(guest.page.getByTestId('form-send')).toHaveCount(0);

      // Required is checked before anything is sent.
      await guest.page.getByTestId('form-submit').click();
      await expect(fill.getByText('This question is required')).toBeVisible();
      await fill.getByRole('radio', { name: 'Yes' }).check();
      await fill.getByRole('textbox', { name: 'Your name' }).fill('Ada');
      await guest.page.screenshot({ path: testInfo.outputPath('fill.png') });
      await guest.page.getByTestId('form-submit').click();
      await expect(guest.page.getByTestId('form-sent')).toBeVisible({ timeout: 30_000 });
      await expect(guest.page.getByTestId('form-delivered')).toBeVisible({ timeout: 30_000 });
    } finally {
      await guest.close();
    }

    // The maker sees it come in, and still has it after a reload.
    await expect(page.getByTestId('form-results-count')).toHaveText('1 response', { timeout: 60_000 });
    const row = page.getByTestId('form-response-row');
    await expect(row).toContainText('Yes');
    await expect(row).toContainText('Ada');
    await expect(page.getByTestId('form-summary-count').first()).toHaveText('1');
    await page.screenshot({ path: testInfo.outputPath('responses.png') });
    await page.waitForTimeout(2_000);
    await page.reload();
    await page.getByTestId('form-tab-responses').click();
    await expect(page.getByTestId('form-results-count')).toHaveText('1 response', { timeout: 60_000 });

    // Where the responses are kept is never listed in My Drive.
    await page.getByTitle('Back to folder').click();
    await expect(page.getByTestId('file-list')).toContainText('Party', { timeout: 30_000 });
    await expect(page.getByTestId('file-list')).not.toContainText('.iris-forms');

    // Closed, the form says so instead of taking answers.
    await page.getByTestId('file-list').getByText('Party').click();
    await page.getByTestId('form-tab-responses').click();
    await page.getByTestId('form-taking-responses').uncheck();
    await page.getByTestId('form-preview').click();
    await expect(page.getByTestId('form-closed')).toBeVisible();
  });

  test('a form for the maker\'s network keeps answers from people they follow and leaves out others', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await createForm(page, 'Club');
    const card = page.getByTestId('question-card').first();
    await card.getByTestId('question-title').fill('Favourite day');
    await card.getByTestId('question-option').first().fill('Monday');
    const link = await sendLink(page, 'network');
    await page.getByTestId('form-send').click();
    await expect(page.getByTestId('form-reach')).toHaveValue('2');
    await page.getByTestId('form-reach').selectOption('1');
    await page.keyboard.press('Escape');

    const signedOut = await newVisitor(browser, relayUrl);
    const friend = await newVisitor(browser, relayUrl);
    const stranger = await newVisitor(browser, relayUrl);
    try {
      // Someone signed out is asked to sign in.
      await openForm(signedOut.page, link, 'Favourite day');
      await expect(signedOut.page.getByTestId('form-fill-network')).toBeVisible();
      await expect(signedOut.page.getByTestId('form-sign-in')).toBeVisible();
      await expect(signedOut.page.getByTestId('form-submit')).toHaveCount(0);

      await createDriveProfile(friend.page, 'Friend');
      await createDriveProfile(stranger.page, 'Stranger');
      const friendKey = await pubkeyOf(friend.page);

      // The owner follows Friend.
      await page.evaluate(async (followed) => {
        const { nostr } = await import('/src/nostr/index.ts');
        const event = await nostr.signEvent({ kind: 3, created_at: Math.floor(Date.now() / 1000), tags: [['p', followed]], content: '' });
        await nostr.publish(event);
      }, friendKey);
      await expect.poll(() => page.evaluate(async (followed) => {
        const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
        return getWorkerAdapter()?.getFollowDistance(followed);
      }, friendKey), { timeout: 30_000 }).toBe(1);

      for (const visitor of [friend.page, stranger.page]) {
        await openForm(visitor, link, 'Favourite day');
        await expect(visitor.getByTestId('form-fill-network')).toContainText('Answering as');
        await visitor.getByTestId('form-fill').getByRole('radio', { name: 'Monday' }).check();
        await visitor.getByTestId('form-submit').click();
        await expect(visitor.getByTestId('form-sent')).toBeVisible({ timeout: 30_000 });
        await expect(visitor.getByTestId('form-delivered')).toBeVisible({ timeout: 30_000 });
      }
    } finally {
      await signedOut.close();
      await friend.close();
      await stranger.close();
    }

    await page.getByTestId('form-tab-responses').click();
    await expect(page.getByTestId('form-results-count')).toHaveText('1 response', { timeout: 60_000 });
    await expect(page.getByTestId('form-held-back')).toContainText('1 response was left out', { timeout: 30_000 });
    await expect(page.getByTestId('form-response-row')).toContainText('Friend', { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('network-responses.png') });
  });
});
