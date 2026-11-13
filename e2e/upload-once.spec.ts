// Publishing a Drive version must not send the file server blocks it already
// confirmed: a share or an approval publishes several versions in a row and
// waits for every upload they cause.
import { expect, test, type BrowserContext, type Page } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

function watchUploads(context: BrowserContext): string[] {
  const hashes: string[] = [];
  context.on('request', (request) => {
    if (request.method() !== 'PUT' || !request.url().endsWith('/upload')) return;
    hashes.push(request.headers()['x-sha-256'] ?? '?');
  });
  return hashes;
}

function sentMoreThanOnce(hashes: string[]): string[] {
  return [...new Set(hashes.filter((hash, index) => hashes.indexOf(hash) !== index))];
}

async function inviteLink(page: Page): Promise<string> {
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
  const create = page.getByTestId('share-people-create');
  await expect(create.or(page.getByTestId('share-people-link'))).toBeVisible({ timeout: 30_000 });
  if (await create.isVisible()) await create.click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-role').selectOption('editor');
  await page.getByTestId('share-people-link').click();
  return page.evaluate(() => navigator.clipboard.readText());
}

test('sharing a document and letting someone in sends no block to the file server twice', async ({ page, browser, relayUrl }) => {
  test.setTimeout(240_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const ownerUploads = watchUploads(page.context());
  await prepareFreshSession(page, relayUrl);
  const owner = await createDriveProfile(page, 'Upload Once');
  await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });
  const origin = new URL(page.url()).origin;

  await createDocument(page, 'Trip plan');
  await typeInDocument(page, 'Bring the tent and the blue kettle.');
  await expectSaved(page);
  await page.waitForTimeout(3000);
  const beforeShare = ownerUploads.length;
  expect(beforeShare).toBeGreaterThan(0);

  await page.getByTestId('document-share').click();
  const link = await inviteLink(page);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 60_000 });

  const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const guestUploads = watchUploads(guestContext);
  const guest = await guestContext.newPage();
  await prepareFreshSession(guest, relayUrl);
  await guest.goto(`${origin}/#${link.split('#')[1]}`);
  await createDriveProfile(guest, 'Guest Reader');
  await expect(guest.getByTestId('document-content').locator('.ProseMirror')).toContainText('blue kettle', { timeout: 120_000 });
  await page.waitForTimeout(5000);

  // Everything the share and the join published was already on the server.
  expect(ownerUploads.length - beforeShare).toBeLessThanOrEqual(4);
  expect(sentMoreThanOnce(ownerUploads)).toEqual([]);
  expect(sentMoreThanOnce(guestUploads)).toEqual([]);
  await guestContext.close();
});
