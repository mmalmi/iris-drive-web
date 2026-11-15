import { expect, test, type Page } from './fixtures';
import { chooseNew } from './test-utils';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';

/** What someone sees at a shared folder's address, and through a link to a copy of it. */

async function makeFolder(page: Page, name: string): Promise<void> {
  await chooseNew(page, 'Folder');
  await page.getByPlaceholder('Folder name...').fill(name);
  await page.getByPlaceholder('Folder name...').press('Enter');
  await page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name}\\b`) }).first().dblclick();
  await expect(page).toHaveURL(new RegExp(`/main/${name}$`), { timeout: 30_000 });
}

async function openShare(page: Page): Promise<void> {
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
}

async function createInviteLink(page: Page): Promise<string> {
  await page.getByTestId('share-tab-people').click();
  await page.getByTestId('share-people-create').click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/share-join/');
  return link;
}

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

test.describe('access to shared folders', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a shared folder address says at once that it needs an invite, and opens for members', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await makeFolder(page, 'Trip');
    await openShare(page);
    const invite = await createInviteLink(page);
    await page.keyboard.press('Escape');
    // Sharing moves the owner into the shared folder: this is the address people copy.
    await expect(page).not.toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    const address = new URL(page.url()).hash;
    expect(address).toMatch(/^#\/[0-9a-f-]{36}\/main$/);

    // The invite link lets people join; it does not open the folder to anyone with it.
    const badge = page.getByTestId('access-badge');
    await expect(badge).toHaveAttribute('data-access', 'people');
    await expect(badge).toHaveText('Shared');
    await expect(badge).toHaveAttribute('title', /invite link can join/);

    const visitorContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);

      // Signed out: no endless loading, but what to do, with signing in right there.
      await visitor.goto(`${new URL(visitor.url()).origin}/${address}`);
      const noAccess = visitor.getByTestId('no-access');
      await expect(noAccess).toBeVisible({ timeout: 10_000 });
      await expect(noAccess).toContainText('You need access');
      await expect(visitor.getByTestId('no-access-hint')).toContainText('invite link');
      await expect(visitor.getByTestId('generate-new-account')).toBeVisible();
      await expect(visitor.getByText('Loading...')).toHaveCount(0);
      await visitor.screenshot({ path: testInfo.outputPath('signed-out.png') });

      // Creating an account here comes back here; still not a member, so the same answer.
      await createDriveProfile(visitor, 'Visitor');
      await expect(visitor).toHaveURL(new RegExp(`${address}$`), { timeout: 30_000 });
      await expect(noAccess).toBeVisible({ timeout: 10_000 });
      await expect(noAccess.getByRole('link', { name: 'Go to My Drive' })).toBeVisible();
      await expect(visitor.getByTestId('generate-new-account')).toHaveCount(0);
      await visitor.screenshot({ path: testInfo.outputPath('signed-in.png') });

      // Joining with the invite opens the folder, and its address opens it from then on.
      await visitor.goto(onThisOrigin(visitor, invite));
      await expect(visitor).toHaveURL(new RegExp(`${address}$`), { timeout: 90_000 });
      await expect(visitor.getByTestId('folder-header')).toContainText('Trip', { timeout: 60_000 });
      await visitor.reload();
      await expect(visitor.getByTestId('folder-header')).toContainText('Trip', { timeout: 60_000 });
      await expect(noAccess).toHaveCount(0);
    } finally {
      await visitorContext.close();
    }
  });

  test('a person is added from the search straight away, without making an invite link first', async ({ page, browser, relayUrl }) => {
    const bobContext = await browser.newContext();
    try {
      const bob = await bobContext.newPage();
      await prepareFreshSession(bob, relayUrl);
      const bobAccount = await createDriveProfile(bob, 'Bob');

      await prepareFreshSession(page, relayUrl);
      await createDriveProfile(page, 'Alice');
      await makeFolder(page, 'Garden');
      await openShare(page);
      await page.getByTestId('share-tab-people').click();
      await expect(page.getByTestId('share-people-link')).toHaveCount(0);
      await page.getByTestId('share-people-search').fill(bobAccount.npub);
      await page.getByTestId('share-people-result').first().click({ timeout: 60_000 });

      await expect(page.getByTestId('share-people-member')).toHaveCount(2, { timeout: 60_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('access-badge')).toHaveText('Shared with 1', { timeout: 30_000 });

      await bob.goto(`${new URL(bob.url()).origin}/#/shared-with-me`);
      await expect(bob.getByTestId('shared-with-me-row').filter({ hasText: 'Garden' })).toBeVisible({ timeout: 60_000 });
    } finally {
      await bobContext.close();
    }
  });

  test('a read-only copy link says what it gives and opens without an account', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await makeFolder(page, 'Photos');
    await page.getByTestId('upload-files-input').setInputFiles({
      name: 'caption.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Sunset at the lake.'),
    });
    await expect(page.getByRole('link', { name: /^caption\.txt\b/ }).first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('viewer-back').click().catch(() => {});

    await openShare(page);
    // The dialog opens on inviting people; the copy link is beside it.
    await page.getByTestId('share-tab-link').click();
    await expect(page.getByTestId('share-tab-link')).toHaveText('Read-only copy');
    await expect(page.getByTestId('share-link-note')).toHaveText(
      'Anyone with this link can view a copy as it is now, without an account. Later changes are not included.',
    );
    await page.getByTestId('share-copy-url').click();
    const copyLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(copyLink).toMatch(/#\/nhash1/);
    await page.keyboard.press('Escape');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, copyLink));
      await expect(visitor.getByRole('link', { name: /^caption\.txt\b/ }).first()).toBeVisible({ timeout: 60_000 });
      // Nothing asks the visitor to sign up first.
      await expect(visitor.getByTestId('drive-setup')).toHaveCount(0);
      await expect(visitor.getByTestId('no-access')).toHaveCount(0);
      await visitor.getByRole('link', { name: /^caption\.txt\b/ }).first().dblclick();
      await expect(visitor.getByText('Sunset at the lake.')).toBeVisible({ timeout: 60_000 });
    } finally {
      await visitorContext.close();
    }
  });
});
