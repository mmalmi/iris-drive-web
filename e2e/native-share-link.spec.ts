import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';
import { configureNativeRelay, irisDriveAvailable, runIdriveJson } from './native-idrive';
import { chooseNew, getTestBlossomUrl } from './test-utils';
import { createDocument, createDriveProfile, expectSaved, prepareFreshSession, typeInDocument } from './documents.helpers';

/**
 * Sharing by link across the native app and the browser: whoever opens a
 * link asks to join, and the sharer's Drive, native or web, lets them in.
 */

function nativeProfile(root: string, name: string, relayUrl: string): string {
  const dir = path.join(root, name);
  configureNativeRelay(dir, relayUrl);
  runIdriveJson(dir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
  runIdriveJson(dir, ['blossom-servers', 'add', getTestBlossomUrl()]);
  runIdriveJson(dir, ['init', '--label', name]);
  runIdriveJson(dir, ['publish', '--relay', relayUrl, '--timeout', '2']);
  return dir;
}

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

/** One sync pass at a time, until `done` holds: what the app does whenever it is open. */
async function syncUntil(dir: string, relayUrl: string, done: () => boolean): Promise<void> {
  await expect.poll(() => {
    runIdriveJson(dir, ['sync', '--relay', relayUrl, '--timeout', '2']);
    return done();
  }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe(true);
}

test.describe('sharing by link between the app and the browser', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a link from the app lets a visitor without an account read the folder in the browser', async ({ page, relayUrl }, testInfo) => {
    test.skip(!irisDriveAvailable() && !process.env.IRIS_DRIVE_BIN, 'Native Drive is required for this cross-app journey');
    const root = testInfo.outputPath('profiles');
    fs.mkdirSync(root, { recursive: true });
    const alice = nativeProfile(root, 'alice', relayUrl);
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'Picnic'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Picnic', 'Plan.txt'), 'Meet at noon.');
    fs.writeFileSync(path.join(source, 'Private.txt'), 'Not shared.');
    runIdriveJson(alice, ['import', source]);
    const { share } = runIdriveJson(alice, ['shares', 'create', 'Picnic']);
    const { link } = runIdriveJson(alice, ['shares', 'link', share.share_id, '--role', 'reader']);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/share-join\//);
    runIdriveJson(alice, ['publish', '--relay', relayUrl, '--timeout', '2']);

    await prepareFreshSession(page, relayUrl);
    await page.goto(onThisOrigin(page, link));
    await expect(page.getByTestId('share-join-signin')).toContainText('Picnic', { timeout: 30_000 });
    await createDriveProfile(page, 'Visitor');

    // Alice's app lets the visitor in the next time it syncs.
    await syncUntil(alice, relayUrl, () =>
      runIdriveJson(alice, ['shares', 'members', share.share_id]).members.length === 2);

    await expect(page.getByRole('link', { name: /^Plan\.txt\b/ })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Private.txt', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: /^Plan\.txt\b/ }).dblclick();
    await expect(page.getByText('Meet at noon.', { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath('visitor-reads-native-share.png') });
  });

  test('a link from the browser lets an app user join the folder', async ({ page, relayUrl }, testInfo) => {
    test.skip(!irisDriveAvailable() && !process.env.IRIS_DRIVE_BIN, 'Native Drive is required for this cross-app journey');
    const root = testInfo.outputPath('profiles');
    fs.mkdirSync(root, { recursive: true });

    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await page.getByRole('link', { name: /^Trip\b/ }).first().dblclick();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await createDocument(page, 'Packing');
    await typeInDocument(page, 'Tent and maps.');
    await expectSaved(page);
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    if (await page.getByTestId('share-people').count() === 0) await page.getByTestId('share-tab-people').click();
    const create = page.getByTestId('share-people-create');
    await expect(create.or(page.getByTestId('share-people-link'))).toBeVisible({ timeout: 30_000 });
    if (await create.isVisible()) await create.click();
    await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('share-people-role').selectOption('reader');
    await page.getByTestId('share-people-link').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');

    const bob = nativeProfile(root, 'bob', relayUrl);
    const asked = runIdriveJson(bob, ['shares', 'accept', link]);
    expect(asked).toMatchObject({ status: 'waiting', name: 'Trip', role: 'reader' });
    expect(runIdriveJson(bob, ['shares', 'list']).waiting_to_join).toHaveLength(1);

    // The owner's open browser lets Bob in; Bob's app finds out on its next sync.
    await syncUntil(bob, relayUrl, () =>
      runIdriveJson(bob, ['shares', 'list']).shares.some((item: { share_id: string }) => item.share_id === asked.share_id));
    const listed = runIdriveJson(bob, ['shares', 'list']);
    expect(listed.waiting_to_join).toHaveLength(0);
    expect(listed.shares.find((item: { share_id: string }) => item.share_id === asked.share_id)).toMatchObject({ local_role: 'reader' });
  });
});
