import { expect, test, type Page } from './fixtures';
import { createDocument, createDriveProfile, prepareFreshSession } from './documents.helpers';
import { chooseNew } from './test-utils';

/** The search box finds names in this Drive: My Drive and its shared folders. */

async function newFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().click();
  await expect(page).toHaveURL(new RegExp(`/main/${name}$`), { timeout: 30_000 });
}

async function addFile(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => (window as any).__testHelpers?.uploadSingleFile);
  await page.evaluate(async (fileName) => {
    await (window as any).__testHelpers.uploadSingleFile(fileName, new TextEncoder().encode(`contents of ${fileName}`));
  }, name);
  await expect(page.getByTestId('file-list').getByText(name).first()).toBeVisible({ timeout: 30_000 });
}

async function search(page: Page, query: string) {
  const input = page.getByTestId('drive-search-input').filter({ visible: true }).first();
  await input.click();
  await input.fill(query);
  return page.getByTestId('drive-search-result');
}

/** My Drive with a folder holding a file and a document, and a shared folder holding a file. */
async function fillDrive(page: Page, relayUrl: string): Promise<{ profileId: string }> {
  await prepareFreshSession(page, relayUrl);
  const owner = await createDriveProfile(page, 'Searcher');
  await newFolder(page, 'Projects');
  await addFile(page, 'Quarterly report.txt');
  await createDocument(page, 'Budget plan');
  await page.goto(`${new URL(page.url()).origin}/#/${owner.profileId}/main`);
  await newFolder(page, 'Trip');
  await addFile(page, 'Tickets.txt');
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
  await page.getByTestId('share-people-create').click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await page.goto(`${new URL(page.url()).origin}/#/${owner.profileId}/main`);
  return owner;
}

test.describe('searching Drive', () => {
  test.setTimeout(180_000);

  test('finds a file, a folder, a document by title and a file in a shared folder', async ({ page, relayUrl }, testInfo) => {
    const { profileId } = await fillDrive(page, relayUrl);

    // Before typing: what was opened lately.
    await page.getByTestId('drive-search-input').click();
    await expect(page.getByTestId('drive-search-results')).toContainText('Recent');

    let results = await search(page, 'quarter');
    await expect(results.first()).toContainText('Quarterly report.txt', { timeout: 30_000 });
    await expect(results.first()).toContainText('My Drive / Projects');
    await page.screenshot({ path: testInfo.outputPath('search-desktop.png') });
    await results.first().click();
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main/Projects/Quarterly%20report\\.txt$`));

    results = await search(page, 'projects');
    await expect(results.first()).toContainText('Projects', { timeout: 30_000 });
    await results.first().click();
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main/Projects$`));

    results = await search(page, 'budget');
    await expect(results.first()).toContainText('Budget plan', { timeout: 30_000 });
    await expect(results.first().locator('.i-lucide-file-text, [class*="i-lucide"]').first()).toBeVisible();
    await results.first().click();
    await expect(page.getByTestId('document-title')).toHaveText('Budget plan', { timeout: 30_000 });

    results = await search(page, 'tickets');
    await expect(results.first()).toContainText('Tickets.txt', { timeout: 30_000 });
    await expect(results.first()).toContainText('Trip');
    await results.first().click();
    // It opens inside the shared folder, not the private copy it was made from.
    await expect(page).not.toHaveURL(new RegExp(`#/${profileId}/`));
    await expect(page).toHaveURL(/\/main\/Tickets\.txt$/);

    await search(page, 'nothing like this');
    await expect(page.getByTestId('drive-search-results')).toContainText('Nothing found', { timeout: 30_000 });
  });

  test('works from the search button on a phone', async ({ page, relayUrl }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { profileId } = await fillDrive(page, relayUrl);
    await expect(page.getByTestId('drive-search-input').filter({ visible: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const results = await search(page, 'quarter');
    await expect(results.first()).toContainText('Quarterly report.txt', { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('search-phone.png') });
    await results.first().click();
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main/Projects/Quarterly%20report\\.txt$`));
  });
});
