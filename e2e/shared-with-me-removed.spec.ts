// A folder someone removed you from leaves Shared with me's list for a small
// "Removed from" section at the bottom, where it no longer opens.
import { expect, test, type Page } from './fixtures';
import { chooseNew } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';

async function makeFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().dblclick();
  await expect(page).toHaveURL(new RegExp(`/main/${name}$`), { timeout: 30_000 });
}

async function openPeople(page: Page): Promise<void> {
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
}

test('a folder you were removed from moves to "Removed from"', async ({ page, browser, relayUrl }, testInfo) => {
  test.setTimeout(240_000);
  const bobContext = await browser.newContext();
  try {
    const bob = await bobContext.newPage();
    await prepareFreshSession(bob, relayUrl);
    const bobAccount = await createDriveProfile(bob, 'Bob');

    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Alice');
    await makeFolder(page, 'Garden');
    await openPeople(page);
    await page.getByTestId('share-people-search').fill(bobAccount.npub);
    await page.getByTestId('share-people-result').first().click({ timeout: 60_000 });
    await expect(page.getByTestId('share-people-member')).toHaveCount(2, { timeout: 60_000 });
    await page.keyboard.press('Escape');

    await bob.goto(`${new URL(bob.url()).origin}/#/shared-with-me`);
    const garden = bob.getByTestId('shared-with-me-row').filter({ hasText: 'Garden' });
    await expect(garden).toBeVisible({ timeout: 90_000 });
    await expect(bob.getByTestId('shared-with-me-removed')).toHaveCount(0);
    const folderHref = (await garden.getByTestId('shared-with-me-open').getAttribute('href'))!;
    // Open, so Bob's device follows the folder's access list.
    await garden.getByTestId('shared-with-me-open').click();
    await expect(bob.getByTestId('folder-header')).toContainText('Garden', { timeout: 60_000 });

    await openPeople(page);
    await page.getByTestId('share-people-remove').click();
    await expect(page.getByTestId('share-people-member')).toHaveCount(1, { timeout: 60_000 });
    await page.keyboard.press('Escape');

    await expect(bob.getByText('You no longer have access to this folder.', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(new URL(bob.url()).hash).toBe(folderHref);

    // Bob's list keeps only what opens; the folder is named below, apart.
    await bob.goto(`${new URL(bob.url()).origin}/#/shared-with-me`);
    await expect(bob.getByTestId('shared-with-me-removed').filter({ hasText: 'Garden' })).toBeVisible({ timeout: 30_000 });
    await expect(garden).toHaveCount(0);
    await expect(bob.getByTestId('shared-with-me-open')).toHaveCount(0);
    await expect(bob.getByTestId('shared-with-me-removed-section')).toContainText('Removed from');
    await expect(bob.getByTestId('shared-with-me-removed').getByRole('link')).toHaveCount(0);
    await expect(bob.getByTestId('shared-with-me-panel')).not.toContainText('Revoked');
    await bob.screenshot({ path: testInfo.outputPath('removed-from.png') });
  } finally {
    await bobContext.close();
  }
});
