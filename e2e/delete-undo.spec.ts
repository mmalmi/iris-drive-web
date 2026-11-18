import { LinkType } from '@hashtree/core';
// Deleting asks nothing and says what went, as Google Drive does, with Undo
// available by button or keyboard: that puts it back with its contents and the
// link that showed it to anyone.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, expectFolderEditable, fileRow, openFolderMenu, openListedFile, openRowMenu, uploadIntoFolder } from './test-utils';

const text = (name: string, body: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });
const undo = (page: Page) => page.getByTestId('toast-action').filter({ hasText: 'Undo' });

test.describe('deleting', () => {
  test.setTimeout(240_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('offers Undo, which puts back a file, and a folder with what is in it', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Undoer');
    await expectFolderEditable(page);
    await uploadIntoFolder(page, text('notes.txt', 'Buy bread'));

    const prompts: string[] = [];
    page.on('dialog', (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await (await openRowMenu(page, 'notes.txt')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'notes.txt')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Deleted “notes.txt”')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('undo-toast.png') });
    await undo(page).click();
    await expect(fileRow(page, 'notes.txt')).toBeVisible({ timeout: 30_000 });
    await expect(undo(page)).toHaveCount(0);
    await openListedFile(page, 'notes.txt');
    await expect(page.locator('pre')).toContainText('Buy bread', { timeout: 30_000 });

    // The open folder: back to the one it was in, and Undo brings it back whole.
    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    await createAndEnterFolder(page, 'Trip');
    await uploadIntoFolder(page, text('plan.txt', 'Day one'));
    await openFolderMenu(page);
    await page.getByTestId('delete-folder-btn').click();
    await expect(page).toHaveURL(new RegExp(`/${owner.profileId}/main$`), { timeout: 30_000 });
    await expect(fileRow(page, 'Trip')).toHaveCount(0, { timeout: 30_000 });
    await undo(page).click();
    await expect(fileRow(page, 'Trip')).toBeVisible({ timeout: 30_000 });
    await fileRow(page, 'Trip').getByRole('link').dblclick();
    await expect(fileRow(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
    expect(prompts).toEqual([]);

    // Kept after a reload, as any change.
    await page.reload();
    await expect(fileRow(page, 'plan.txt')).toBeVisible({ timeout: 30_000 });
  });

  test('Ctrl or Command Z undoes successive deletions after ten seconds and leaves text editing alone', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Keyboard Undo');
    await expectFolderEditable(page);
    await uploadIntoFolder(page, [text('first.txt', 'one'), text('second.txt', 'two')]);

    await fileRow(page, 'first.txt').getByRole('link').click();
    await page.keyboard.press('Delete');
    await expect(fileRow(page, 'first.txt')).toHaveCount(0);
    await fileRow(page, 'second.txt').getByRole('link').click();
    await page.keyboard.press('#');
    await expect(fileRow(page, 'second.txt')).toHaveCount(0);
    const notice = page.getByRole('status').filter({ hasText: 'Deleted “second.txt”' });
    await expect(notice).toBeVisible();
    await expect(undo(page)).toHaveCount(1);

    // The toast's old 10-second timer would have been installed by this point.
    await expect.poll(() => page.evaluate(() => Date.now()), { intervals: [1000], timeout: 15000 })
      .toBeGreaterThan(Date.now() + 10000);
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss' }).click();

    const field = page.getByTestId('drive-search-input').filter({ visible: true });
    await field.focus();
    await field.press('w');
    await expect(field).toHaveValue('w');
    await field.press('ControlOrMeta+z');
    await expect(field).toHaveValue('');
    await expect(fileRow(page, 'second.txt')).toHaveCount(0);

    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Trash' }).click();
    const trash = page.getByTestId('trash-route');
    await expect(trash.getByRole('button', { name: 'Restore second.txt' })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(trash.getByRole('button', { name: 'Restore second.txt' })).toHaveCount(0);
    await expect(trash.getByRole('button', { name: 'Restore first.txt' })).toBeVisible();

    await page.goto(`${new URL(page.url()).origin}/#/${owner.profileId}/main`);
    await expect(fileRow(page, 'second.txt')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(fileRow(page, 'first.txt')).toBeVisible();
  });

  test('an old Trash row for a share that no longer grants access stays private', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Recovery');
    await expectFolderEditable(page);
    await page.evaluate(async ({ account, type }) => {
      const { archiveTrash } = await import('/src/lib/driveTrash.ts');
      const { getTree } = await import('/src/store.ts');
      const tree = getTree();
      const file = await tree.putFile(new TextEncoder().encode('archived'));
      const archived = (scope: string, name: string) => ({
        id: crypto.randomUUID(), account, scope, treeName: 'main', path: [],
        deletedAt: Date.now(), ready: false, entry: { ...file, name, type },
      });
      await archiveTrash(tree, [
        archived(account, 'personal.txt'),
        archived(crypto.randomUUID(), 'former-share.txt'),
      ]);
    }, { account: owner.profileId, type: LinkType.Blob });
    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Trash' }).click();
    const trash = page.getByTestId('trash-route');
    await expect(trash.getByRole('button', { name: 'Restore personal.txt' })).toBeVisible();
    await expect(trash).not.toContainText('former-share.txt');
  });

  test('Trash restores after a reload, keeps a newer file, and reconstructs a missing parent', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Restorer');
    const home = `#/${owner.profileId}/main`;
    await expectFolderEditable(page);
    await createAndEnterFolder(page, 'Notes');
    await uploadIntoFolder(page, [text('meeting.txt', 'first version'), text('todo.txt', 'remember this')]);
    for (const name of ['meeting.txt', 'todo.txt']) {
      await (await openRowMenu(page, name)).getByRole('menuitem', { name: 'Delete' }).click();
      await expect(fileRow(page, name)).toHaveCount(0);
    }
    await page.evaluate(hash => { window.location.hash = hash; }, home);
    await (await openRowMenu(page, 'Notes')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'Notes')).toHaveCount(0);

    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Trash' }).click();
    await page.reload();
    const trash = page.getByTestId('trash-route');
    await expect(trash.getByRole('button', { name: 'Restore meeting.txt' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('trash.png') });
    // The recovery store independently holds the bytes. Even when a second
    // reference expires, the live one retains its blocks.
    const kept = await page.evaluate(async account => {
      const { listTrash, getTrash, archiveTrash, expireTrash, recoverContents, TRASH_RETENTION } = await import('/src/lib/driveTrash.ts');
      const { getTree } = await import('/src/store.ts');
      const item = (await listTrash(account)).find(row => row.entry.name === 'meeting.txt')!;
      // A conflicting import can neither replace another account's recovery
      // row nor remove its only copy of the blocks.
      const collision = { ...item, account: crypto.randomUUID(), id: item.id };
      const extra = { ...collision, id: crypto.randomUUID() };
      let rejected = false;
      try {
        await archiveTrash(getTree(), [extra, collision]);
      } catch {
        rejected = true;
      }
      if (!rejected || await getTrash(extra.id, extra.account) || !await getTrash(item.id, account)) {
        throw new Error('A conflicting Trash batch changed existing recovery data');
      }
      await archiveTrash(getTree(), [{ ...item, id: crypto.randomUUID(), deletedAt: Date.now() - TRASH_RETENTION }]);
      await expireTrash();
      const data = new Map();
      const store = {
        get: async hash => data.get(hash.toString()) ?? null, has: async hash => data.has(hash.toString()),
        put: async (hash, bytes) => { data.set(hash.toString(), bytes); return true; },
      };
      const fresh = new (getTree().constructor)({ store });
      await recoverContents(fresh, item);
      return {
        contents: new TextDecoder().decode(await fresh.readFile(item.entry.cid)),
        foreign: Boolean(await getTrash(item.id, 'a different account')),
      };
    }, owner.profileId);
    expect(kept).toEqual({ contents: 'first version', foreign: false });
    await trash.getByRole('button', { name: 'Restore todo.txt' }).click();
    await expect(trash.getByRole('button', { name: 'Restore todo.txt' })).toHaveCount(0);
    await page.evaluate(hash => { window.location.hash = hash + '/Notes'; }, home);
    await expect(fileRow(page, 'todo.txt')).toBeVisible();
    await uploadIntoFolder(page, text('meeting.txt', 'newer file'));

    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Trash' }).click();
    await trash.getByRole('button', { name: 'Restore meeting.txt' }).click();
    await expect(trash.getByRole('button', { name: 'Restore meeting.txt' })).toHaveCount(0);
    await page.evaluate(hash => { window.location.hash = hash + '/Notes'; }, home);
    await expect(fileRow(page, 'meeting.txt')).toBeVisible();
    await openListedFile(page, 'meeting (2).txt');
    await expect(page.locator('pre')).toContainText('first version');
  });

  test('Undo turns the link of what was deleted back on', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page, 'Sharer');
    await expectFolderEditable(page);
    await createAndEnterFolder(page, 'Trip');
    await uploadIntoFolder(page, text('plan.txt', 'Day one'));

    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    await page.getByTestId('share-tab-people').click();
    await page.getByTestId('general-access-select').selectOption('link');
    await page.getByTestId('general-access-link').click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link');

    await page.evaluate((profileId) => { window.location.hash = `/${profileId}/main`; }, owner.profileId);
    await (await openRowMenu(page, 'Trip')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'Trip')).toHaveCount(0, { timeout: 30_000 });
    await undo(page).click();
    await fileRow(page, 'Trip').getByRole('link').dblclick({ timeout: 30_000 });
    await expect(page.getByTestId('access-badge')).toHaveAttribute('data-access', 'link', { timeout: 30_000 });

    const visitorContext = await browser.newContext();
    try {
      const visitor = await visitorContext.newPage();
      await prepareFreshSession(visitor, relayUrl);
      await visitor.goto(`${new URL(visitor.url()).origin}/#${link.split('#')[1]}`);
      await expect(async () => {
        await visitor.reload();
        await expect(fileRow(visitor, 'plan.txt')).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 90_000 });
    } finally {
      await visitorContext.close();
    }
  });
});
