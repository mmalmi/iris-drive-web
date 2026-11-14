import { expect, test, type BrowserContext, type Page } from './fixtures';
import { createDocument, createDriveProfile, documentBody, expectSaved, linkSecondDevice, prepareFreshSession, typeInDocument } from './documents.helpers';
import { chooseNew, expectFolderEditable, fileRow, flushPendingPublishes, openRowMenu, waitForRelayConnected } from './test-utils';

/**
 * A document renamed or deleted on one device while another device has it
 * open and keeps typing. Every save is a file added to the document's folder,
 * so a device that has not yet heard of the rename saves into the old folder
 * name. The document must still end up as one, under the new name, with all
 * that was typed on either device.
 */

/** Renames the open document the way a person does: click the title, type, Enter. */
async function renameFromTitle(page: Page, from: string, to: string): Promise<void> {
  await page.getByTestId('document-title').click();
  const field = page.getByTestId('document-title-input');
  await expect(field).toHaveValue(from);
  await field.fill(to);
  await field.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/${encodeURIComponent(to)}\\.irisdoc$`), { timeout: 30_000 });
}

/** Renames a document in the open folder from its row's menu. */
async function renameFromRowMenu(page: Page, scope: string, from: string, to: string): Promise<void> {
  const menu = await openRowMenu(page, `${from}.irisdoc`);
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByPlaceholder('New name...').fill(to);
  await page.getByPlaceholder('New name...').press('Enter');
  await expect.poll(() => documentsIn(page, scope), { timeout: 30_000 }).toContain(`${to}.irisdoc`);
  await flushPendingPublishes(page);
}

/** The documents at the top of a Drive, as the page holds it now. */
async function documentsIn(page: Page, scope: string): Promise<string[]> {
  return page.evaluate(async (scope) => {
    const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
    const { getTree } = await import('/src/store.ts');
    const root = getTreeRootSync(scope, 'main');
    if (!root) return [];
    const entries = await getTree().listDirectory(root);
    return entries.map(entry => entry.name).filter(name => name.endsWith('.irisdoc')).sort();
  }, scope);
}

/**
 * Types one word after another, each once the editor shows the one before,
 * the editor being found again each time: it is put up anew when the page
 * follows the document to its new name. Resolves to the words that showed.
 */
async function keepTyping(page: Page, prefix: string, count: number, pauseMs: number): Promise<string[]> {
  const typed: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const word = `${prefix}${index}`;
    await expect(async () => {
      await documentBody(page).click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type(` ${word}`);
      await expect(documentBody(page)).toContainText(word, { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    typed.push(word);
    await page.waitForTimeout(pauseMs);
  }
  return typed;
}

/** Waits until both pages hold exactly `names` at the top of the Drive, and still do a while later. */
async function expectSettled(pages: Page[], scope: string, names: string[]): Promise<void> {
  for (const page of pages) await flushPendingPublishes(page);
  for (const page of pages) {
    await expect.poll(() => documentsIn(page, scope), { timeout: 60_000 }).toEqual(names);
  }
  // A device that missed the change would put the old name back with its next save.
  await pages[0].waitForTimeout(5000);
  for (const page of pages) expect(await documentsIn(page, scope)).toEqual(names);
}

/** Nothing typed on the page is still waiting to be saved. */
async function expectNothingWaiting(page: Page): Promise<void> {
  await expect(page.getByTestId('document-save-status')).toHaveAttribute('data-state', /^(idle|saved)$/, { timeout: 30_000 });
}

async function expectAllText(page: Page, parts: string[]): Promise<void> {
  for (const part of parts) await expect(documentBody(page)).toContainText(part, { timeout: 30_000 });
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
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('#/share-join/');
  return link;
}

/** Two devices of one account with `title` open on both. */
async function openOnTwoDevices(page: Page, device: Page, relayUrl: string, profileId: string, title: string, text: string): Promise<void> {
  await linkSecondDevice(page, device, relayUrl, profileId);
  await page.goto(`/#/${profileId}/main`);
  await createDocument(page, title);
  await typeInDocument(page, text);
  await expectSaved(page);
  await device.goto(page.url());
  await expect(documentBody(device)).toContainText(text, { timeout: 90_000 });
}

test.describe('renaming or deleting a document that another device is typing in', () => {
  test.setTimeout(360_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  let deviceContext: BrowserContext | undefined;
  test.afterEach(async () => {
    await deviceContext?.close();
    deviceContext = undefined;
  });

  test('renamed from the title while the other device types: one document under the new name with everything', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Owner');
    deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await openOnTwoDevices(page, device, relayUrl, profileId, 'Notes', 'Written first.');

    // The other device types a word every half second, before, during and after the rename.
    const typing = keepTyping(device, 'word', 14, 500);
    await page.waitForTimeout(2500);
    await renameFromTitle(page, 'Notes', 'Plan');
    await typeInDocument(page, ' Renamer adds this.');
    const words = await typing;
    await expectSaved(page);

    await expect(device).toHaveURL(/\/Plan\.irisdoc$/, { timeout: 30_000 });
    await expect(device.getByTestId('document-title')).toHaveText('Plan');
    await expectNothingWaiting(device);
    await expectSettled([page, device], profileId, ['Plan.irisdoc']);
    const all = ['Written first.', 'Renamer adds this.', ...words];
    await expectAllText(device, all);
    await expectAllText(page, all);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectAllText(page, all);
  });

  test('renamed from the row menu while the other device saved edits offline: they join the renamed document', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Owner');
    deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await openOnTwoDevices(page, device, relayUrl, profileId, 'Notes', 'Written first.');

    // Saved on the device while it cannot hear of the rename: these saves go to the old name.
    await deviceContext.setOffline(true);
    await typeInDocument(device, ' Typed offline.');
    await expect(device.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await renameFromRowMenu(page, profileId, 'Notes', 'Plan');

    await deviceContext.setOffline(false);
    await waitForRelayConnected(device, 30_000);
    await expect(device).toHaveURL(/\/Plan\.irisdoc$/, { timeout: 60_000 });
    await typeInDocument(device, ' Back online.');
    await expectSaved(device);
    await expectSettled([page, device], profileId, ['Plan.irisdoc']);
    const all = ['Written first.', 'Typed offline.', 'Back online.'];
    await expectAllText(device, all);
    await page.goto(device.url());
    await expectAllText(page, all);
  });

  test('renamed while an upload into the same folder is still saving: both stay', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Owner');
    await expectFolderEditable(page);
    await createDocument(page, 'Notes');
    await typeInDocument(page, 'Written first.');
    await expectSaved(page);
    await page.getByRole('link', { name: 'Back to folder' }).click();

    // Each uploaded file is saved into the folder on its own; renames come between them.
    const names = Array.from({ length: 200 }, (_, index) => `scan-${String(index).padStart(3, '0')}.txt`);
    await page.getByTestId('upload-files-input').setInputFiles(names.map((name, index) => ({
      name, mimeType: 'text/plain', buffer: Buffer.from(`scan ${index} `.repeat(200)),
    })));
    await expect(fileRow(page, names[0]!)).toBeVisible({ timeout: 30_000 });
    // What the Rename dialog of a row does, a few times over while files keep landing.
    const renamed = await page.evaluate(async () => {
      const { renameEntry } = await import('/src/actions/index.ts');
      let name = 'Notes';
      for (let round = 1; round <= 8; round += 1) {
        await renameEntry(`${name}.irisdoc`, `Plan ${round}.irisdoc`);
        name = `Plan ${round}`;
      }
      return `${name}.irisdoc`;
    });
    expect(await fileRow(page, names[names.length - 1]!).count()).toBe(0);

    for (const name of names) await expect(fileRow(page, name)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => documentsIn(page, profileId), { timeout: 30_000 }).toEqual([renamed]);
    await flushPendingPublishes(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (const name of names) await expect(fileRow(page, name)).toBeVisible({ timeout: 60_000 });
    expect(await documentsIn(page, profileId)).toEqual([renamed]);
  });

  test('two people in a shared folder: renamed by one while the other types', async ({ page, browser, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Owner');
    await chooseNew(page, 'Folder');
    await page.getByPlaceholder('Folder name...').fill('Team');
    await page.getByPlaceholder('Folder name...').press('Enter');
    await page.getByRole('link', { name: /^Team\b/ }).first().click();
    await expect(page).toHaveURL(/\/main\/Team$/, { timeout: 30_000 });
    await createDocument(page, 'Notes');
    await typeInDocument(page, 'Written first.');
    await expectSaved(page);
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await page.locator('button[title="Share"]').filter({ visible: true }).first().click();
    const link = await inviteLink(page);
    await page.keyboard.press('Escape');

    deviceContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const guest = await deviceContext.newPage();
    await prepareFreshSession(guest, relayUrl);
    await createDriveProfile(guest, 'Guest');
    await guest.goto(`${new URL(guest.url()).origin}/#${link.split('#')[1]}`);
    const entry = guest.getByTestId('document-entry').filter({ hasText: 'Notes' }).first();
    await expect(entry).toBeVisible({ timeout: 90_000 });
    await entry.click();
    await expect(documentBody(guest)).toContainText('Written first.', { timeout: 90_000 });
    await expect(guest.getByTestId('document-toolbar')).toBeVisible({ timeout: 30_000 });
    // Both work in the shared folder's own Drive.
    const shareId = decodeURIComponent(new URL(guest.url()).hash.split('/')[1]!);
    await page.goto(guest.url());
    await expect(documentBody(page)).toContainText('Written first.', { timeout: 60_000 });

    const typing = keepTyping(guest, 'guest', 12, 500);
    await page.waitForTimeout(2500);
    await renameFromTitle(page, 'Notes', 'Plan');
    const words = await typing;
    await expect(guest).toHaveURL(/\/Plan\.irisdoc$/, { timeout: 60_000 });
    await expectNothingWaiting(guest);
    await expectNothingWaiting(page);
    await expectSettled([page, guest], shareId, ['Plan.irisdoc']);
    await expectAllText(guest, ['Written first.', ...words]);
    await expectAllText(page, ['Written first.', ...words]);
  });

  test('deleted while open on the other device: it stays deleted and that device says so, unless edits it saved without knowing keep it', async ({ page, browser, relayUrl }, testInfo) => {
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Owner');
    deviceContext = await browser.newContext();
    const device = await deviceContext.newPage();
    await openOnTwoDevices(page, device, relayUrl, profileId, 'Notes', 'Written first.');

    await page.getByTestId('document-delete').click();
    await expect(page).toHaveURL(new RegExp(`/${profileId}/main$`), { timeout: 30_000 });
    // The other device learns the document is gone, and typing there does not bring part of it back.
    await expect(device.getByTestId('document-save-status')).toHaveAttribute('data-state', 'deleted', { timeout: 60_000 });
    await expect(device.getByTestId('document-content').locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    await expect(device.getByTestId('document-save-status')).toHaveText('Deleted');
    await device.screenshot({ path: testInfo.outputPath('deleted-elsewhere.png') });
    await device.keyboard.type(' Too late.');
    await expectSettled([page, device], profileId, []);

    // Edits saved where the delete could not be heard of keep the whole document.
    await createDocument(page, 'Draft');
    await typeInDocument(page, 'Draft text.');
    await expectSaved(page);
    await device.goto(page.url());
    await expect(documentBody(device)).toContainText('Draft text.', { timeout: 90_000 });
    await deviceContext.setOffline(true);
    await typeInDocument(device, ' Kept offline.');
    await expect(device.getByTestId('document-save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
    await page.getByTestId('document-delete').click();
    await expect.poll(() => documentsIn(page, profileId), { timeout: 30_000 }).toEqual([]);
    await flushPendingPublishes(page);
    await deviceContext.setOffline(false);
    await waitForRelayConnected(device, 30_000);
    await expectSettled([page, device], profileId, ['Draft.irisdoc']);
    await expectNothingWaiting(device);
    await page.goto(device.url());
    await expectAllText(page, ['Draft text.', 'Kept offline.']);
  });
});
