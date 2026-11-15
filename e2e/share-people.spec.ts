import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew } from './test-utils';

/**
 * Adding a person to a shared folder by searching for them, the person page
 * that names and avatars lead to, and the name people see.
 */

async function follow(page: Page, npub: string): Promise<void> {
  const decoded = nip19.decode(npub);
  await page.waitForFunction(() => (window as any).__testHelpers?.followPubkey);
  expect(await page.evaluate((pubkey) => (window as any).__testHelpers.followPubkey(pubkey), decoded.data as string)).toBe(true);
}

async function newFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().dblclick();
  await expect(page).toHaveURL(new RegExp(`/main/${name}$`), { timeout: 30_000 });
}

async function setOwnName(page: Page, name: string): Promise<void> {
  await page.goto(`${new URL(page.url()).origin}/#/settings`);
  await page.getByTestId('settings-nav-account').click();
  await page.getByTestId('settings-own-name').fill(name);
  await page.getByTestId('settings-own-name-save').click();
  await expect(page.getByTestId('settings-own-name-save')).toHaveText('Saved');
}

test.describe('adding people to a shared folder', () => {
  test.setTimeout(240_000);

  test('finds a followed person by name, adds them as editor, and they see the folder', async ({ page, browser, relayUrl }, testInfo) => {
    const bobContext = await browser.newContext();
    try {
      const bob = await bobContext.newPage();
      await prepareFreshSession(bob, relayUrl);
      const bobAccount = await createDriveProfile(bob, 'Bob Tester');
      // The name others see is changed in Settings.
      await setOwnName(bob, 'Bobby Example');
      await bob.screenshot({ path: testInfo.outputPath('settings-name.png') });

      await prepareFreshSession(page, relayUrl);
      const alice = await createDriveProfile(page, 'Alice Tester');
      await follow(page, bobAccount.npub);
      await follow(bob, alice.npub);

      // Someone with a similar name this browser happens to know, whom Alice does not follow.
      const stranger = getPublicKey(generateSecretKey());
      await page.evaluate(async (pubkey) => {
        const { indexUsers } = await import('/src/stores/searchIndex.ts');
        await indexUsers([{ pubkey, name: 'Bob Stranger' }]);
      }, stranger);

      await newFolder(page, 'Garden');
      await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
      if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
      await page.getByTestId('share-people-create').click();
      await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });

      // Names arrive from relays while searching; the person followed comes first.
      const search = page.getByTestId('share-people-search');
      const results = page.getByTestId('share-people-result');
      await expect(async () => {
        await search.fill('');
        await search.fill('bob');
        await expect(results).toHaveCount(2, { timeout: 3_000 });
        await expect(results.first()).toContainText('Bobby Example', { timeout: 3_000 });
      }).toPass({ timeout: 60_000 });
      await expect(results.first()).toContainText('You follow them');
      await expect(results.nth(1)).toContainText('Bob Stranger');
      await page.screenshot({ path: testInfo.outputPath('share-people-search.png') });

      await page.getByTestId('share-people-add-role').selectOption('editor');
      await results.first().click();
      await expect(page.getByTestId('share-people-adding')).toContainText('Adding');
      await expect(page.getByTestId('share-people-member')).toHaveCount(2, { timeout: 60_000 });
      await expect(page.getByTestId('share-people-adding')).toHaveCount(0);
      const bobRow = page.getByTestId('share-people-member').filter({ hasText: 'Bobby Example' });
      await expect(bobRow.getByTestId('share-people-member-role')).toHaveValue('editor');
      await page.screenshot({ path: testInfo.outputPath('share-people-added.png') });

      // Bob finds the folder in Shared with me without opening any link.
      await bob.goto(`${new URL(bob.url()).origin}/#/shared-with-me`);
      await expect(bob.getByTestId('shared-with-me-row').filter({ hasText: 'Garden' })).toBeVisible({ timeout: 90_000 });
      await expect(bob.getByTestId('shared-with-me-owner')).toHaveText('Alice Tester');

      // From the share dialog, Bob's name opens his page in Drive, which leads on to Iris.
      await bobRow.getByTestId('share-people-member-link').click();
      await expect(page.getByTestId('person-page')).toBeVisible();
      await expect(page.getByTestId('share-modal')).toHaveCount(0);
      await expect(page.getByTestId('person-name')).toHaveText('Bobby Example');
      await expect(page.getByTestId('person-you-share')).toContainText('Garden');
      await expect(page.getByTestId('person-iris-link')).toHaveAttribute('href', `https://iris.to/${bobAccount.npub}`);
      await expect(page.getByTestId('person-iris-link')).toHaveAttribute('rel', 'noreferrer');
      await expect(page.getByTestId('person-chat-link')).toHaveAttribute('href', `https://chat.iris.to/#/${bobAccount.npub}`);
      await page.screenshot({ path: testInfo.outputPath('person-page.png') });

      // Bob reaches Alice's page from Shared with me; the folder is listed as shared with him.
      await bob.getByTestId('shared-with-me-owner').click();
      await expect(bob.getByTestId('person-name')).toHaveText('Alice Tester');
      await expect(bob.getByTestId('person-shared-with-you')).toContainText('Garden');
      await bob.getByTestId('person-shared-with-you').getByTestId('person-item').click();
      await expect(bob).toHaveURL(/\/main$/);

      // Old links to people this device knows nothing about still show a page.
      const unknown = nip19.npubEncode(stranger);
      await page.goto(`${new URL(page.url()).origin}/#/${unknown}/profile`);
      await expect(page.getByTestId('person-page')).toBeVisible();
      await expect(page.getByTestId('person-shared-with-you')).toContainText('Nothing yet');
      await page.goto(`${new URL(page.url()).origin}/#/${unknown}`);
      await expect(page.getByTestId('person-iris-link')).toHaveAttribute('href', `https://iris.to/${unknown}`);
    } finally {
      await bobContext.close();
    }
  });

  test('says so when a person has no Drive devices to add', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await newFolder(page, 'Notes');
    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
    await page.getByTestId('share-people-create').click();
    await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });

    const nobody = nip19.npubEncode(getPublicKey(generateSecretKey()));
    await page.getByTestId('share-people-search').fill(nobody);
    await page.getByTestId('share-people-result').first().click();
    await expect(page.getByTestId('share-people-adding-error')).toContainText('Send them the invite link instead', { timeout: 60_000 });
    // The link is still there to send.
    await expect(page.getByTestId('share-people-link')).toBeVisible();
    await expect(page.getByTestId('share-people-member')).toHaveCount(1);
  });
});
