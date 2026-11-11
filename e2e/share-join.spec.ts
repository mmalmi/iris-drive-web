import { expect, test, type Page } from './fixtures';
import { flushPendingPublishes } from './test-utils';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

/** Everything here happens in browsers only: no native app is involved. */

async function inviteLink(page: Page, role: 'editor' | 'reader' = 'editor'): Promise<string> {
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
  const create = page.getByTestId('share-people-create');
  await expect(create.or(page.getByTestId('share-people-link'))).toBeVisible({ timeout: 30_000 });
  if (await create.isVisible()) await create.click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-role').selectOption(role);
  await page.getByTestId('share-people-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/share-join/');
  return link;
}

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

test.describe('sharing from the browser', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a document shared by link is edited by the owner and a guest together', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Owner');
    await createDocument(page, 'Plan');
    await typeInDocument(page, 'Owner wrote this.');
    await expectSaved(page);

    await page.getByTestId('document-share').click();
    const link = await inviteLink(page);
    await page.screenshot({ path: testInfo.outputPath('invite-people.png') });
    await page.keyboard.press('Escape');
    // The owner now works inside the shared folder, not in the private copy.
    await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 30_000 });
    await expect(page).toHaveURL(/\/main\/Plan\.irisdoc$/);
    await expect(documentBody(page)).toContainText('Owner wrote this.', { timeout: 60_000 });

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await createDriveProfile(guest, 'Guest');
      await guest.goto(onThisOrigin(guest, link));

      // The guest is let in without anyone clicking anything, and can write.
      await expect(guest).toHaveURL(/\/main\/Plan\.irisdoc$/, { timeout: 90_000 });
      await expect(documentBody(guest)).toContainText('Owner wrote this.', { timeout: 90_000 });
      await expect(guest.getByTestId('document-toolbar')).toBeVisible({ timeout: 30_000 });
      await typeInDocument(guest, ' Guest added this.');
      await expectSaved(guest);

      await expect(documentBody(page)).toContainText('Guest added this.', { timeout: 90_000 });
      await typeInDocument(page, ' Owner replied.');
      await expectSaved(page);
      await expect(documentBody(guest)).toContainText('Owner replied.', { timeout: 90_000 });
      await expect(documentBody(guest)).toContainText('Guest added this.');
      await guest.screenshot({ path: testInfo.outputPath('guest-editing.png') });

      // Both are listed for the owner, and the guest finds the folder again later.
      await page.getByTestId('document-share').click();
      await expect(page.getByTestId('share-people-member')).toHaveCount(2, { timeout: 30_000 });
      await expect(page.getByTestId('share-people-list')).toContainText('Guest');
      await page.screenshot({ path: testInfo.outputPath('people-list.png') });
      await page.keyboard.press('Escape');

      await guest.goto(`${new URL(guest.url()).origin}/#/shared-with-me`);
      await expect(guest.getByText('Plan').first()).toBeVisible({ timeout: 30_000 });

      // Removing the guest ends their editing.
      await page.getByTestId('document-share').click();
      await page.getByTestId('share-people-remove').click();
      await expect(page.getByTestId('share-people-member')).toHaveCount(1, { timeout: 30_000 });
      await page.keyboard.press('Escape');
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('share-join-waiting').or(guest.getByTestId('document-content'))).toBeVisible({ timeout: 30_000 });
      await expect(guest.getByTestId('document-toolbar')).toHaveCount(0, { timeout: 60_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('a guest who opens the link while the owner is away is let in when the owner comes back', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Owner');
    await createDocument(page, 'Minutes');
    await typeInDocument(page, 'Agenda.');
    await expectSaved(page);
    await page.getByTestId('document-share').click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/main\/Minutes\.irisdoc$/);
    await flushPendingPublishes(page);
    const ownerOrigin = new URL(page.url()).origin;
    // The owner closes Drive.
    await page.goto('about:blank');

    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await createDriveProfile(guest, 'Guest');
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('share-join-slow')).toBeVisible({ timeout: 40_000 });

      // The owner opens Drive again, anywhere in it: the waiting guest gets in.
      await page.goto(`${ownerOrigin}/#/${owner.profileId}/main`);
      await expect(guest).toHaveURL(/\/main\/Minutes\.irisdoc$/, { timeout: 90_000 });
      await expect(documentBody(guest)).toContainText('Agenda.', { timeout: 90_000 });
      await typeInDocument(guest, ' Guest item.');
      await expectSaved(guest);

      // Opening the document from the owner's own Drive leads to the shared one.
      await page.getByTestId('document-entry').filter({ hasText: 'Minutes' }).first().click();
      await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 30_000 });
      await expect(documentBody(page)).toContainText('Guest item.', { timeout: 90_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('a visitor without an account creates one and lands in the shared folder, read-only for a view link', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await page.locator('button[title="New Folder"]').filter({ visible: true }).first().click();
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await page.getByRole('link', { name: /^Trip\b/ }).first().click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await createDocument(page, 'Packing');
    await typeInDocument(page, 'Tent and maps.');
    await expectSaved(page);
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });

    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    const link = await inviteLink(page, 'reader');
    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('share-join-signin')).toContainText('Trip', { timeout: 30_000 });
      await createDriveProfile(guest, 'Reader');

      await expect(guest.getByTestId('document-entry').filter({ hasText: 'Packing' }).first()).toBeVisible({ timeout: 90_000 });
      await guest.getByTestId('document-entry').filter({ hasText: 'Packing' }).first().click();
      await expect(documentBody(guest)).toContainText('Tent and maps.', { timeout: 90_000 });
      await expect(guest.getByText('View only')).toBeVisible();
      await expect(guest.getByTestId('document-toolbar')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
