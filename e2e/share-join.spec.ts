import { expect, test, type Page } from './fixtures';
import { chooseNew, chooseFileAction, openListedFile, flushPendingPublishes } from './test-utils';
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

    // Until it is shared, the document says it is private.
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'private');
    await page.getByTestId('access-badge').click();
    const link = await inviteLink(page);
    await page.screenshot({ path: testInfo.outputPath('invite-people.png') });
    await page.keyboard.press('Escape');
    // The owner now works inside the shared folder, not in the private copy.
    await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 30_000 });
    await expect(page).toHaveURL(/\/main\/Plan\.irisdoc$/);
    await expect(documentBody(page)).toContainText('Owner wrote this.', { timeout: 60_000 });
    // An invite link lets people join; it does not open the document to anyone who has it.
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'people');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('title', 'Shared, nobody has joined yet. People with the invite link can join');
    await expect(page.getByTestId('access-badge')).not.toContainText(/anyone/i);

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
      // Each sees who else can open it: the owner who joined and that the link lets more join, the guest that it is shared.
      await expect(page.getByTestId('access-badge')).toHaveAttribute('title', 'Shared with 1 person. People with the invite link can join', { timeout: 30_000 });
      await expect(guest.getByTestId('access-badge')).toHaveAttribute('data-access', 'people');
      await expect(guest.getByTestId('access-badge')).toContainText('Shared with 1');

      // Both are listed for the owner, and the guest finds the folder again later.
      await page.getByTestId('document-share').click();
      await expect(page.getByTestId('share-people-member')).toHaveCount(2, { timeout: 30_000 });
      await expect(page.getByTestId('share-people-list')).toContainText('Guest');
      await page.screenshot({ path: testInfo.outputPath('people-list.png') });
      await page.keyboard.press('Escape');

      // In the owner's Drive the shared document is marked in the list, where everything else is private.
      await page.getByRole('link', { name: 'My Drive' }).click();
      await expect(page.getByTestId('document-entry').getByTestId('access-icon')).toHaveAttribute('data-access', 'people', { timeout: 30_000 });
      await page.screenshot({ path: testInfo.outputPath('owner-drive-list.png') });
      await page.goBack();
      await expect(documentBody(page)).toContainText('Owner replied.', { timeout: 60_000 });

      await guest.goto(`${new URL(guest.url()).origin}/#/shared-with-me`);
      await expect(guest.getByText('Plan').first()).toBeVisible({ timeout: 30_000 });

      // Removing the guest ends their editing.
      await page.getByTestId('document-share').click();
      await page.getByTestId('share-people-remove').click();
      await expect(page.getByTestId('share-people-member')).toHaveCount(1, { timeout: 30_000 });
      // Resetting the link replaces it, so the one already handed out stops admitting people.
      await page.getByTestId('share-people-reset').click();
      await page.getByTestId('share-people-link').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).not.toBe(link);
      await page.keyboard.press('Escape');
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('share-join-waiting').or(guest.getByTestId('document-content'))).toBeVisible({ timeout: 30_000 });
      await expect(guest.getByTestId('document-toolbar')).toHaveCount(0, { timeout: 60_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('a file uploaded before a shared folder has loaded lands in it, and My Drive keeps its files', async ({
    page,
    browser,
    relayUrl,
  }) => {
    test.setTimeout(180_000);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Folder admin');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await openListedFile(page, 'Trip');
    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');
    const context = await browser.newContext();
    try {
      const guest = await context.newPage();
      await prepareFreshSession(guest, relayUrl);
      const member = await createDriveProfile(guest, 'Member');
      await guest
        .getByTestId('upload-files-input')
        .setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Personal file') });
      await expect(guest.getByRole('link', { name: /^Notes.txt/ })).toBeVisible();
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('upload-files-input')).toBeAttached({ timeout: 90000 });
      await guest.waitForFunction(
        async () => {
          const { parseRoute } = await import('/src/utils/route.ts');
          const { activeShareScope } = await import('/src/drive/shareScope.ts');
          const route = parseRoute();
          return route.treeName === 'main' && !route.path.length && activeShareScope(route.npub)?.canWrite;
        },
        undefined,
        { timeout: 90000 },
      );

      // The file is chosen at a moment the folder's contents are not known here, as right after joining.
      await guest.evaluate(async () => {
        const { parseRoute } = await import('/src/utils/route.ts');
        const { invalidateTreeRoot, getTreeRootSync } = await import('/src/stores/treeRoot.ts');
        const route = parseRoute();
        const input = document.querySelector<HTMLInputElement>('[data-testid="upload-files-input"]')!;
        const chosen = new DataTransfer();
        chosen.items.add(new File(['Original contents'], 'Packing.txt', { type: 'text/plain' }));
        void invalidateTreeRoot(route.npub, route.treeName);
        if (getTreeRootSync(route.npub, route.treeName)) throw new Error('The shared folder is still loaded');
        input.files = chosen.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await expect(guest.getByRole('link', { name: /^Packing.txt/ })).toBeVisible({ timeout: 60_000 });
      const mine = await guest.evaluate(async (profileId) => {
        const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
        const { getTree } = await import('/src/store.ts');
        const root = getTreeRootSync(profileId, 'main');
        return root ? (await getTree().listDirectory(root)).map((entry) => entry.name) : null;
      }, member.profileId);
      expect(mine).toContain('Notes.txt');
      expect(mine).not.toContain('Packing.txt');
      // The other person gets it too.
      await page.goto(guest.url());
      await expect(page.getByRole('link', { name: /^Packing.txt/ })).toBeVisible({ timeout: 60_000 });
    } finally {
      await context.close();
    }
  });

  test('removing an editor’s file returns the exact edited bytes to its owner across devices', async ({
    page,
    browser,
    relayUrl,
  }, testInfo) => {
    test.setTimeout(180_000);
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Folder admin');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Trip');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await openListedFile(page, 'Trip');
    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');
    const creator = await browser.newContext();
    const replacement = await browser.newContext();
    try {
      const guest = await creator.newPage();
      await prepareFreshSession(guest, relayUrl);
      const owner = await createDriveProfile(guest, 'File owner');
      await guest
        .getByTestId('upload-files-input')
        .setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Personal file') });
      await expect(guest.getByRole('link', { name: /^Notes.txt/ })).toBeVisible();
      await guest.goto(onThisOrigin(guest, link));
      await expect(guest.getByTestId('upload-files-input')).toBeAttached({ timeout: 90000 });
      // The invite navigates into the shared folder after admission.
      await guest.waitForFunction(
        async () => {
          const { parseRoute } = await import('/src/utils/route.ts');
          const { activeShareScope } = await import('/src/drive/shareScope.ts');
          const route = parseRoute();
          return route.treeName === 'main' && !route.path.length && activeShareScope(route.npub)?.canWrite;
        },
        undefined,
        { timeout: 90000 },
      );
      await guest
        .getByTestId('upload-files-input')
        .setInputFiles({ name: 'Packing.txt', mimeType: 'text/plain', buffer: Buffer.from('Original contents') });
      await expect(guest.getByRole('link', { name: /^Packing.txt/ })).toBeVisible();
      const sharedUrl = guest.url();
      await page.goto(sharedUrl);
      await openListedFile(page, 'Packing.txt');
      await chooseFileAction(page, 'viewer-rename');
      await page.getByPlaceholder('New name...').fill('Notes.txt');
      await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
      await expect(page.getByTestId('viewer-header')).toContainText('Notes.txt');
      await page.getByRole('link', { name: 'Back to folder' }).click();
      await expect(page.getByTestId('file-list')).toBeVisible();
      const bytes = Buffer.from('Updated by another person. Café and maps.');
      await page
        .getByTestId('upload-files-input')
        .setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: bytes });
      await openListedFile(page, 'Notes.txt');
      await expect(page.getByText(bytes.toString(), { exact: true })).toBeVisible();
      await flushPendingPublishes(page);
      await creator.setOffline(true);
      await chooseFileAction(page, 'viewer-delete');
      await expect(page.getByText(/Removal requested/)).toBeVisible();
      await page.goto(sharedUrl);
      await expect(page.getByRole('link', { name: /^Notes.txt/ })).toBeVisible();
      await creator.setOffline(false);
      await guest.waitForFunction(
        async (id) => {
          const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
          const { getTree } = await import('/src/store.ts');
          const root = getTreeRootSync(id, 'main');
          return (
            !!root &&
            (await getTree().listDirectory(root)).some(
              (entry) => entry.name === 'Notes (2).txt' && entry.meta?.iris_returned_from,
            )
          );
        },
        owner.profileId,
        { timeout: 90000 },
      );
      const { waitForSharedFolderPublished } = await import('./shared-folder.helpers');
      await waitForSharedFolderPublished(page, new URL(sharedUrl).hash.split('/')[1], { lacks: ['Notes.txt'] });
      await expect(page.getByRole('link', { name: /^Notes.txt/ })).toHaveCount(0, { timeout: 30000 });
      await guest.goto(new URL(guest.url()).origin + '/#/' + owner.profileId + '/main');
      await openListedFile(guest, 'Notes (2).txt');
      await expect(guest.getByText(bytes.toString(), { exact: true })).toBeVisible();
      await creator.setOffline(true);
      await guest.getByRole('link', { name: 'Back to folder' }).click();
      await openListedFile(guest, 'Notes (2).txt');
      await expect(guest.getByText(bytes.toString(), { exact: true })).toBeVisible();
      await creator.setOffline(false);
      const second = await replacement.newPage();
      const { linkSecondDevice } = await import('./documents.helpers');
      await linkSecondDevice(guest, second, relayUrl, owner.profileId);
      await second.goto(new URL(second.url()).origin + '/#/' + owner.profileId + '/main');
      await openListedFile(second, 'Notes (2).txt');
      await expect(second.getByText(bytes.toString(), { exact: true })).toBeVisible();
      await second.screenshot({ path: testInfo.outputPath('returned-file-on-new-device.png') });

      const ownName = 'Own packing list.txt';
      await guest.goto(sharedUrl);
      await guest.getByTestId('upload-files-input').setInputFiles({
        name: ownName,
        mimeType: 'text/plain',
        buffer: Buffer.from('My private packing list'),
      });
      await openListedFile(guest, ownName);
      await chooseFileAction(guest, 'viewer-delete');
      await waitForSharedFolderPublished(guest, new URL(sharedUrl).hash.split('/')[1], { lacks: [ownName] });
      await second.goto(new URL(sharedUrl).origin + '/#/trash');
      const restore = second.getByRole('button', { name: 'Restore ' + ownName });
      await expect(restore).toBeVisible({ timeout: 60000 });
      await restore.click();
      await expect(restore).toHaveCount(0);
      await second.goto(new URL(sharedUrl).origin + '/#/' + owner.profileId + '/main');
      await openListedFile(second, ownName);
      await expect(second.getByText('My private packing list', { exact: true })).toBeVisible();
    } finally {
      await creator.close();
      await replacement.close();
    }
  });

  test('what an earlier guest writes reaches a guest who joined later, with the owner away', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await createDocument(page, 'Notes');
    await typeInDocument(page, 'Start.');
    await expectSaved(page);
    await page.getByTestId('document-share').click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');

    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    try {
      const first = await firstContext.newPage();
      await prepareFreshSession(first, relayUrl);
      await createDriveProfile(first, 'First');
      await first.goto(onThisOrigin(first, link));
      await expect(documentBody(first)).toContainText('Start.', { timeout: 90_000 });
      await typeInDocument(first, ' First was here.');
      await expectSaved(first);

      const second = await secondContext.newPage();
      await prepareFreshSession(second, relayUrl);
      await createDriveProfile(second, 'Second');
      await second.goto(onThisOrigin(second, link));
      await expect(documentBody(second)).toContainText('First was here.', { timeout: 90_000 });

      // The owner leaves; the two guests keep working with each other.
      await expect(documentBody(page)).toContainText('First was here.', { timeout: 90_000 });
      await flushPendingPublishes(page);
      await page.goto('about:blank');
      await typeInDocument(first, ' First again.');
      await expectSaved(first);
      await expect(documentBody(second)).toContainText('First again.', { timeout: 90_000 });
      await typeInDocument(second, ' Second answers.');
      await expectSaved(second);
      await expect(documentBody(first)).toContainText('Second answers.', { timeout: 90_000 });
    } finally {
      await firstContext.close();
      await secondContext.close();
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
      await page.getByTestId('document-entry').filter({ hasText: 'Minutes' }).first().dblclick();
      await expect(page).not.toHaveURL(new RegExp(`#/${owner.profileId}/`), { timeout: 30_000 });
      await expect(documentBody(page)).toContainText('Guest item.', { timeout: 90_000 });
    } finally {
      await guestContext.close();
    }
  });

  test('a visitor without an account creates one and lands in the shared folder, read-only for a view link', async ({ page, browser, relayUrl }) => {
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
      await expect(guest.getByRole('link', { name: 'Get the Iris Drive app' })).toHaveCount(0);
      await createDriveProfile(guest, 'Reader');

      await expect(guest.getByTestId('document-entry').filter({ hasText: 'Packing' }).first()).toBeVisible({ timeout: 90_000 });
      await guest.getByTestId('document-entry').filter({ hasText: 'Packing' }).first().dblclick();
      await expect(documentBody(guest)).toContainText('Tent and maps.', { timeout: 90_000 });
      await expect(guest.getByText('View only')).toBeVisible();
      await expect(guest.getByTestId('document-toolbar')).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
});
