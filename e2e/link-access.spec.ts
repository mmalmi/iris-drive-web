import { expect, test, type Page } from './fixtures';
import { chooseNew, openFileMenu, openFolderMenu, openListedFile, openRowMenu } from './test-utils';
import { createDriveProfile, expectSaved, prepareFreshSession, typeInDocument } from './documents.helpers';

/** General access by link: anyone with the link views the latest version, signed out, until it is turned off. */

function row(page: Page, name: string) {
  return page.getByTestId('file-list').locator('a').filter({ has: page.getByTitle(name, { exact: true }) });
}

async function openGeneralAccess(page: Page): Promise<void> {
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('share-tab-people').click();
  await expect(page.getByTestId('general-access')).toBeVisible();
}

async function copiedLink(page: Page): Promise<string> {
  await page.getByTestId('general-access-link').click();
  return page.evaluate(() => navigator.clipboard.readText());
}

function onThisOrigin(page: Page, link: string): string {
  return `${new URL(page.url()).origin}/#${link.split('#')[1]}`;
}

/** Shares the open folder with people: makes its invite link for editors and returns it. */
async function inviteEditors(page: Page): Promise<string> {
  await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('share-people')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('share-people-create').click();
  await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('share-people-role').selectOption('editor');
  await page.getByTestId('share-people-link').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/share-join/');
  return link;
}

/** Opens `link` signed out until `ready` shows, reloading while the newest version is on its way. */
async function expectAfterReload(page: Page, ready: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.reload();
    await ready();
  }).toPass({ timeout: 90_000 });
}

test.describe('anyone with the link can view', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a folder opens signed out by its link, shows each new version, and stops when turned off', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await row(page, 'Trip').click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Day one') });
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });

    // Restricted until it is changed; then a link to copy.
    await openGeneralAccess(page);
    const select = page.getByTestId('general-access-select');
    await expect(select).toHaveValue('off');
    await expect(page.getByTestId('general-access-link')).toHaveCount(0);
    await select.selectOption('link');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('general-access-on.png') });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/Trip\?k=[0-9a-f]+$/);
    await page.keyboard.press('Escape');
    // Still in My Drive, marked for what it is.
    await expect(page).toHaveURL(/\/main\/Trip$/);
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');
    await expect(page.getByTestId('access-badge')).toHaveText('Anyone with the link');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(row(visitor, 'plan.txt')).toBeVisible({ timeout: 60_000 });
      await expect(visitor.getByTestId('drive-setup')).toHaveCount(0);
      await visitor.screenshot({ path: testInfo.outputPath('visitor.png') });

      // A change in My Drive reaches the same link.
      await page.getByTestId('upload-files-input').setInputFiles({ name: 'tickets.txt', mimeType: 'text/plain', buffer: Buffer.from('Seat 12') });
      await expect(row(page, 'tickets.txt')).toBeVisible({ timeout: 30_000 });
      await expect(async () => {
        await visitor.reload();
        await expect(row(visitor, 'tickets.txt')).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      await row(visitor, 'tickets.txt').click();
      await expect(visitor.getByText('Seat 12')).toBeVisible({ timeout: 60_000 });
      // A visitor can look, not change anything.
      await expect(visitor.getByTestId('upload-files-input')).toHaveCount(0);
      const visitorMenu = await openFileMenu(visitor);
      await expect(visitorMenu.getByTestId('viewer-copy')).toBeVisible();
      await expect(visitorMenu.getByTestId('viewer-delete')).toHaveCount(0);
      await visitor.keyboard.press('Escape');

      // Renamed, it keeps its link.
      await page.getByTestId('viewer-back').click().catch(() => {});
      await openFolderMenu(page);
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await page.getByPlaceholder('New name...').fill('Holiday');
      await page.getByPlaceholder('New name...').press('Enter');
      await expect(page).toHaveURL(/\/main\/Holiday$/, { timeout: 30_000 });
      await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');
      await openGeneralAccess(page);
      expect(await copiedLink(page)).toBe(link);

      // Turned off, a new open says the link no longer works, rather than loading for ever.
      await page.getByTestId('general-access-select').selectOption('off');
      await expect(page.getByTestId('general-access-link')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'private');
    } finally {
      await visitorContext.close();
    }

    const laterContext = await browser.newContext();
    try {
      const later = await laterContext.newPage();
      await prepareFreshSession(later, relayUrl);
      await later.goto(onThisOrigin(later, link));
      await expect(later.getByTestId('protected-tree-notice')).toContainText('This link no longer works', { timeout: 60_000 });
      await expect(row(later, 'plan.txt')).toHaveCount(0);
      await expect(later.getByText('Loading...')).toHaveCount(0);
      await later.screenshot({ path: testInfo.outputPath('turned-off.png') });
    } finally {
      await laterContext.close();
    }
  });

  test('a document is shared publicly, opens as a document, and keeps its link once shared with people', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Document');
    await page.getByPlaceholder('Document name...').fill('Notes');
    await page.getByPlaceholder('Document name...').press('Enter');
    await expect(page.getByTestId('document-title')).toHaveText('Notes', { timeout: 30_000 });
    const body = page.getByTestId('document-content').locator('.ProseMirror');
    await body.click();
    await page.keyboard.type('Bring snacks.');
    await expect(page.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

    await page.getByTestId('document-share').click();
    await expect(page.getByTestId('general-access')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('general-access-select').selectOption('public');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/Notes\/Notes\.irisdoc$/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'public');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(visitor.getByTestId('document-content')).toContainText('Bring snacks.', { timeout: 60_000 });
      await expect(visitor.getByTestId('document-toolbar')).toHaveCount(0);

      // Shared with people too, it keeps its link, which shows what is written in the shared document.
      await page.getByTestId('document-share').click();
      await page.getByTestId('share-people-create').click();
      await expect(page.getByTestId('share-people-link')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('general-access-select')).toHaveValue('public');
      expect(await copiedLink(page)).toBe(link);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'public', { timeout: 30_000 });
      await expect(page.getByTestId('access-badge')).toHaveAttribute('title', /^Anyone can find and open this\. Shared with people/);
      await typeInDocument(page, ' Bring water.');
      await expectSaved(page);
      await expectAfterReload(visitor, () => expect(visitor.getByTestId('document-content')).toContainText('Bring water.', { timeout: 10_000 }));
    } finally {
      await visitorContext.close();
    }
  });

  test('a folder shared with people also opens by link, shows what they add, and stops when turned off', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await row(page, 'Trip').click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Day one') });
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });

    // Shared with people first; General access stays offered beside them.
    const invite = await inviteEditors(page);
    const select = page.getByTestId('general-access-select');
    await expect(select).toHaveValue('off');
    await select.selectOption('link');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('people-and-link.png') });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/Trip\?k=[0-9a-f]+$/);
    await page.keyboard.press('Escape');
    // The owner works in the shared folder; its badge leads with the wider access and names both.
    await expect(page).toHaveURL(/\/main$/, { timeout: 30_000 });
    const badge = page.getByTestId('access-badge');
    await expect(badge).toHaveAttribute('data-access', 'link');
    await expect(badge).toHaveText('Anyone with the link');
    await expect(badge).toHaveAttribute('title', /^Anyone with the link can view this\. Shared with people/);
    // A file inside opens through the folder's link.
    await openRowMenu(page, 'plan.txt').then((menu) => menu.getByTestId('row-menu-share').click());
    await expect(page.getByTestId('general-access-through')).toContainText('Anyone with the link to “Trip” can view it', { timeout: 30_000 });
    await expect(page.getByTestId('general-access-select')).toHaveValue('off');
    await page.getByTestId('general-access-through-link').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link.replace('/Trip?', '/Trip/plan.txt?'));
    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const visitorContext = await browser.newContext();
    try {
      const guest = await guestContext.newPage();
      await prepareFreshSession(guest, relayUrl);
      await createDriveProfile(guest, 'Guest');
      await guest.goto(onThisOrigin(guest, invite));
      await expect(row(guest, 'plan.txt')).toBeVisible({ timeout: 90_000 });
      await expect(badge).toHaveAttribute('title', /Shared with 1 person/, { timeout: 60_000 });

      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(row(visitor, 'plan.txt')).toBeVisible({ timeout: 60_000 });
      await expect(visitor.getByTestId('drive-setup')).toHaveCount(0);

      // What a member adds reaches the link while the owner's Drive is open, wherever in it the owner is.
      const sharedFolderUrl = page.url();
      await page.getByRole('navigation').getByRole('link', { name: 'My Drive' }).first().click();
      await expect(row(page, 'Trip')).toBeVisible({ timeout: 30_000 });
      await guest.getByTestId('upload-files-input').setInputFiles({ name: 'tickets.txt', mimeType: 'text/plain', buffer: Buffer.from('Seat 12') });
      await expect(row(guest, 'tickets.txt')).toBeVisible({ timeout: 30_000 });
      await expectAfterReload(visitor, () => expect(row(visitor, 'tickets.txt')).toBeVisible({ timeout: 5_000 }));
      await page.goto(sharedFolderUrl);
      await row(visitor, 'tickets.txt').click();
      await expect(visitor.getByText('Seat 12')).toBeVisible({ timeout: 60_000 });
      await visitor.screenshot({ path: testInfo.outputPath('visitor-sees-member-file.png') });

      // The member is told it opens by link, and cannot change that.
      await expect(guest.getByTestId('access-badge')).toHaveAttribute('data-access', 'link', { timeout: 60_000 });
      await guest.locator('button[title="Share"]').filter({ visible: true }).first().click();
      await expect(guest.getByTestId('general-access-state')).toHaveText('Anyone with the link can view', { timeout: 30_000 });
      await expect(guest.getByTestId('general-access-select')).toHaveCount(0);
      await expect(guest.getByTestId('general-access-link')).toHaveCount(0);
      await guest.screenshot({ path: testInfo.outputPath('member-sees-state.png') });
      await guest.keyboard.press('Escape');

      // Turned off from inside the shared folder: the same link, and new opens stop.
      await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
      await expect(page.getByTestId('general-access-select')).toHaveValue('link', { timeout: 30_000 });
      expect(await copiedLink(page)).toBe(link);
      await page.getByTestId('general-access-select').selectOption('off');
      await expect(page.getByTestId('general-access-link')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(badge).toHaveAttribute('data-access', 'people');
      await expect(guest.getByTestId('access-badge')).toHaveAttribute('data-access', 'people', { timeout: 60_000 });
    } finally {
      await guestContext.close();
      await visitorContext.close();
    }

    const laterContext = await browser.newContext();
    try {
      const later = await laterContext.newPage();
      await prepareFreshSession(later, relayUrl);
      await later.goto(onThisOrigin(later, link));
      await expect(later.getByTestId('protected-tree-notice')).toContainText('This link no longer works', { timeout: 60_000 });
      await expect(row(later, 'plan.txt')).toHaveCount(0);
      await expect(row(later, 'tickets.txt')).toHaveCount(0);
    } finally {
      await laterContext.close();
    }
    // Nor does a file inside it, opened by its address through the link.
    const fileContext = await browser.newContext();
    try {
      const later = await fileContext.newPage();
      await prepareFreshSession(later, relayUrl);
      await later.goto(onThisOrigin(later, link.replace('/Trip?', '/Trip/tickets.txt?')));
      await expect(later.getByTestId('protected-tree-notice').first()).toContainText('This link no longer works', { timeout: 60_000 });
      await expect(later.getByText('Seat 12')).toHaveCount(0);
      await later.screenshot({ path: testInfo.outputPath('file-in-folder-turned-off.png') });
    } finally {
      await fileContext.close();
    }
  });

  test('a folder that opens by link keeps the same link once it is shared with people, and keeps up', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await row(page, 'Trip').click();
    await expect(page).toHaveURL(/\/main\/Trip$/, { timeout: 30_000 });
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Day one') });
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    await openGeneralAccess(page);
    await page.getByTestId('general-access-select').selectOption('link');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    const link = await copiedLink(page);
    await page.keyboard.press('Escape');

    // Shared with people afterwards: the dialog still has the same link.
    await inviteEditors(page);
    await expect(page.getByTestId('general-access-select')).toHaveValue('link');
    expect(await copiedLink(page)).toBe(link);
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/main$/, { timeout: 30_000 });

    // What is added in the shared folder reaches the link.
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'tickets.txt', mimeType: 'text/plain', buffer: Buffer.from('Seat 12') });
    await expect(row(page, 'tickets.txt')).toBeVisible({ timeout: 30_000 });
    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(row(visitor, 'plan.txt')).toBeVisible({ timeout: 60_000 });
      await expectAfterReload(visitor, () => expect(row(visitor, 'tickets.txt')).toBeVisible({ timeout: 5_000 }));
    } finally {
      await visitorContext.close();
    }
  });

  test('a single file opens by its own link, as itself, until it is turned off', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await page.getByTestId('upload-files-input').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('Day one') });
    await expect(row(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });

    // A file is not shared with people, so its dialog has General access and the read-only copy, no People tab.
    await openRowMenu(page, 'plan.txt').then((menu) => menu.getByTestId('row-menu-share').click());
    await expect(page.getByTestId('share-modal')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('share-tab-people')).toHaveCount(0);
    await expect(page.getByTestId('share-link-note')).toBeVisible();
    const select = page.getByTestId('general-access-select');
    await expect(select).toHaveValue('off');
    await select.selectOption('link');
    await expect(page.getByTestId('general-access-link')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('file-general-access.png') });
    const link = await copiedLink(page);
    expect(link).toMatch(/^https:\/\/drive\.iris\.to\/#\/npub1[a-z0-9]+\/plan\.txt\/plan\.txt\?k=[0-9a-f]+$/);
    await page.keyboard.press('Escape');
    await expect(row(page, 'plan.txt').getByTestId('access-icon')).toHaveAttribute('data-access', 'link');

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(onThisOrigin(visitor, link));
      await expect(visitor.getByText('Day one')).toBeVisible({ timeout: 60_000 });
      await expect(visitor.getByTestId('drive-setup')).toHaveCount(0);
      await visitor.screenshot({ path: testInfo.outputPath('file-visitor.png') });
    } finally {
      await visitorContext.close();
    }

    // The file's own page shares the same link, and turns it off.
    await openListedFile(page, 'plan.txt');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');
    await page.getByTestId('viewer-share').click();
    await expect(page.getByTestId('general-access-select')).toHaveValue('link', { timeout: 30_000 });
    expect(await copiedLink(page)).toBe(link);
    await page.getByTestId('general-access-select').selectOption('off');
    await expect(page.getByTestId('general-access-link')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'private');

    const laterContext = await browser.newContext();
    try {
      const later = await laterContext.newPage();
      await prepareFreshSession(later, relayUrl);
      await later.goto(onThisOrigin(later, link));
      await expect(later.getByTestId('protected-tree-notice').first()).toContainText('This link no longer works', { timeout: 60_000 });
      await later.screenshot({ path: testInfo.outputPath('file-turned-off.png') });
      await expect(later.getByText('Day one')).toHaveCount(0);
    } finally {
      await laterContext.close();
    }
  });
});
