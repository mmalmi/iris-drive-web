import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';
import { configureNativeRelay, irisDriveAvailable, runIdriveJson } from './native-idrive';
import { openProfile } from './shared-folder.helpers';
import { createDocument, documentBody, expectSaved, typeInDocument } from './documents.helpers';
import { getTestBlossomUrl } from './test-utils';

const needsNative = !irisDriveAvailable() && !process.env.IRIS_DRIVE_BIN;

function prepareNativeProfile(dir: string, relayUrl: string): void {
  configureNativeRelay(dir, relayUrl);
  runIdriveJson(dir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
  runIdriveJson(dir, ['blossom-servers', 'add', getTestBlossomUrl()]);
}

function logDocumentErrors(page: Page, who: string): void {
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[Document]')) {
      console.log(`${who}:`, message.text().slice(0, 300));
    }
  });
}

/** Opens an invitation link, accepts it and lands in the shared folder. */
async function acceptAndOpen(page: Page, invite: string): Promise<void> {
  // Newer native releases hand out a short link, older ones the invitation itself.
  const reference = invite.split('share-invite/')[1];
  expect(reference).toBeTruthy();
  await page.goto(`${new URL(page.url()).origin}/#/share-invite/${reference}`);
  await expect(page.getByTestId('share-invite-accept')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('share-invite-accept').click();
  await page.getByTestId('share-invite-open').click();
  await expect(page.getByRole('link', { name: /^Plan\.txt\b/ })).toBeVisible({ timeout: 30_000 });
}

/** Names of every file stored below the open document, as this browser's Drive sees it. */
async function storedDocumentFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { parseRoute } = await import('/src/utils/route.ts');
    const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
    const { getTree } = await import('/src/store.ts');
    const route = parseRoute();
    const root = getTreeRootSync(route.npub, route.treeName);
    if (!root) return [];
    const tree = getTree();
    const folder = await tree.resolvePath(root, route.path);
    if (!folder) return [];
    const names: string[] = [];
    const walk = async (cid: typeof folder.cid, prefix: string): Promise<void> => {
      for (const entry of await tree.listDirectory(cid)) {
        if (entry.type === 2) await walk(entry.cid, `${prefix}${entry.name}/`);
        else names.push(`${prefix}${entry.name}`);
      }
    };
    await walk(folder.cid, '');
    return names;
  });
}

async function expectSameText(pages: Page[], fragments: string[]): Promise<void> {
  for (const page of pages) {
    for (const fragment of fragments) {
      await expect(documentBody(page)).toContainText(fragment, { timeout: 60_000 });
    }
  }
  await expect.poll(async () => {
    const texts = await Promise.all(pages.map(page => documentBody(page).innerText()));
    return new Set(texts.map(text => text.replace(/\s+/g, ' ').trim())).size;
  }, { timeout: 60_000 }).toBe(1);
}

test.describe('documents edited by several people and devices', () => {
  test.setTimeout(300_000);
  test.skip(needsNative, 'Native Drive sets up the linked device and the shared folder');

  test('two devices of one Drive edit the same document, also at the same moment', async ({ page, browser, relayUrl }, testInfo) => {
    const root = testInfo.outputPath('devices');
    const laptop = path.join(root, 'laptop');
    const phone = path.join(root, 'phone');
    for (const dir of [laptop, phone]) {
      fs.mkdirSync(dir, { recursive: true });
      prepareNativeProfile(dir, relayUrl);
    }
    runIdriveJson(laptop, ['init', '--label', 'laptop']);
    runIdriveJson(laptop, ['publish', '--relay', relayUrl, '--timeout', '2']);
    const invite = runIdriveJson(laptop, ['app-keys', 'invite']).url as string;
    const request = runIdriveJson(phone, ['link', invite, '--label', 'phone']).app_key_link_request;
    runIdriveJson(laptop, ['app-keys', 'approve', request.url, '--label', 'phone']);
    runIdriveJson(laptop, ['publish', '--relay', relayUrl, '--timeout', '2']);
    runIdriveJson(phone, ['sync', '--relay', relayUrl, '--timeout', '2']);
    runIdriveJson(phone, ['publish', '--relay', relayUrl, '--timeout', '2']);

    const phoneContext = await browser.newContext();
    try {
      logDocumentErrors(page, 'laptop');
      await openProfile(page, laptop, relayUrl);
      const profileId = request.profile_id as string;
      await page.goto(`${new URL(page.url()).origin}/#/${profileId}/main`);
      await createDocument(page, 'Shared notes');
      await typeInDocument(page, 'Written on the laptop.');
      await expectSaved(page);
      const documentUrl = page.url();

      const phonePage = await phoneContext.newPage();
      logDocumentErrors(phonePage, 'phone');
      await openProfile(phonePage, phone, relayUrl);
      await phonePage.goto(documentUrl);
      await expect(documentBody(phonePage)).toContainText('Written on the laptop.', { timeout: 90_000 });
      await expect(phonePage.getByTestId('document-view-only')).toHaveCount(0);

      await typeInDocument(phonePage, ' Added on the phone.');
      await expectSaved(phonePage);
      await expect(documentBody(page)).toContainText('Added on the phone.', { timeout: 60_000 });

      // Both type at the same moment, several times, before either has seen the other's edit.
      for (let round = 1; round <= 3; round += 1) {
        await Promise.all([
          (async () => {
            await documentBody(page).click();
            await page.keyboard.press('ControlOrMeta+Home');
            await page.keyboard.type(`L${round} `);
          })(),
          typeInDocument(phonePage, ` P${round}`),
        ]);
      }
      await expectSaved(page);
      await expectSaved(phonePage);
      const fragments = ['Written on the laptop.', 'Added on the phone.', 'L1 ', 'L2 ', 'L3 ', ' P1', ' P2', ' P3'];
      await expectSameText([page, phonePage], fragments);

      for (const device of [page, phonePage]) {
        await expect.poll(async () => (await storedDocumentFiles(device)).filter(name => name.includes('conflict')), {
          timeout: 30_000,
        }).toEqual([]);
      }
      await phonePage.screenshot({ path: testInfo.outputPath('phone.png') });

      await phonePage.reload({ waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectSameText([page, phonePage], fragments);
    } finally {
      await phoneContext.close();
    }
  });

  test('editors of a shared folder write and comment together while a reader can only read', async ({ page, browser, relayUrl }, testInfo) => {
    const root = testInfo.outputPath('profiles');
    const people = ['alice', 'bob', 'dan', 'cara'] as const;
    const dirs = Object.fromEntries(people.map(name => [name, path.join(root, name)])) as Record<typeof people[number], string>;
    for (const name of people) {
      fs.mkdirSync(dirs[name], { recursive: true });
      prepareNativeProfile(dirs[name], relayUrl);
      runIdriveJson(dirs[name], ['init', '--label', name]);
      runIdriveJson(dirs[name], ['publish', '--relay', relayUrl, '--timeout', '2']);
    }
    const source = path.join(root, 'source');
    fs.mkdirSync(path.join(source, 'Trip'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Trip', 'Plan.txt'), 'Train at noon.');
    runIdriveJson(dirs.alice, ['import', source]);
    const { share } = runIdriveJson(dirs.alice, ['shares', 'create', 'Trip']);
    const inviteFor = (name: 'bob' | 'dan' | 'cara', role: 'editor' | 'reader'): string => {
      const evidence = runIdriveJson(dirs[name], ['shares', 'recipient-evidence', '--display-name', name]);
      const file = path.join(root, `${name}-evidence.json`);
      fs.writeFileSync(file, JSON.stringify(evidence));
      return runIdriveJson(dirs.alice, ['shares', 'invite', share.share_id, '--recipient-evidence', file, '--role', role]).invite as string;
    };
    const invites = { bob: inviteFor('bob', 'editor'), dan: inviteFor('dan', 'editor'), cara: inviteFor('cara', 'reader') };
    runIdriveJson(dirs.alice, ['publish', '--relay', relayUrl, '--timeout', '2']);

    const danContext = await browser.newContext();
    const caraContext = await browser.newContext();
    try {
      logDocumentErrors(page, 'bob');
      await openProfile(page, dirs.bob, relayUrl);
      await acceptAndOpen(page, invites.bob);
      await createDocument(page, 'Itinerary');
      await typeInDocument(page, 'Day one: arrive by train.');
      await expectSaved(page);
      const documentUrl = page.url();

      // Dan opens the folder from the invitation link and finds the document in the list.
      const danPage = await danContext.newPage();
      logDocumentErrors(danPage, 'dan');
      await openProfile(danPage, dirs.dan, relayUrl);
      await acceptAndOpen(danPage, invites.dan);
      await danPage.getByTestId('document-entry').filter({ hasText: 'Itinerary' }).first().click();
      await expect(documentBody(danPage)).toContainText('Day one: arrive by train.', { timeout: 90_000 });
      await typeInDocument(danPage, ' Day two: hike.');
      await expectSaved(danPage);
      await expect(documentBody(page)).toContainText('Day two: hike.', { timeout: 60_000 });

      // Dan comments on the text; Bob sees the comment and replies.
      await documentBody(danPage).click();
      await danPage.keyboard.press('ControlOrMeta+a');
      await danPage.getByTestId('document-add-comment').click();
      await danPage.getByPlaceholder('Write your comment...').fill('Which train?');
      await danPage.getByRole('button', { name: 'Add Comment' }).click();
      await expectSaved(danPage);
      await expect(page.getByTestId('document-comments-count')).toHaveText('1', { timeout: 60_000 });
      await page.getByTestId('document-comments-toggle').click();
      await expect(page.getByText('Which train?')).toBeVisible();
      await page.getByPlaceholder('Reply...').fill('The 10:15.');
      await page.getByPlaceholder('Reply...').press('Enter');
      await expectSaved(page);
      await expect(danPage.getByText('The 10:15.')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath('bob-comments.png') });

      // Both editors type at the same moment.
      await Promise.all([
        typeInDocument(page, ' Bob packs food.'),
        (async () => {
          await documentBody(danPage).click();
          await danPage.keyboard.press('ControlOrMeta+Home');
          await danPage.keyboard.type('Dan brings maps. ');
        })(),
      ]);
      await expectSaved(page);
      await expectSaved(danPage);
      const fragments = ['Day one: arrive by train.', 'Day two: hike.', 'Bob packs food.', 'Dan brings maps.'];
      await expectSameText([page, danPage], fragments);

      // Cara has a reader role: she sees everything and cannot change it.
      const caraPage = await caraContext.newPage();
      logDocumentErrors(caraPage, 'cara');
      await openProfile(caraPage, dirs.cara, relayUrl);
      await acceptAndOpen(caraPage, invites.cara);
      await caraPage.goto(documentUrl.replace(new URL(documentUrl).origin, new URL(caraPage.url()).origin));
      for (const fragment of fragments) {
        await expect(documentBody(caraPage)).toContainText(fragment, { timeout: 90_000 });
      }
      await expect(caraPage.getByTestId('document-view-only')).toBeVisible();
      await expect(caraPage.getByTestId('document-toolbar')).toHaveCount(0);
      await expect(documentBody(caraPage)).toHaveAttribute('contenteditable', 'false');
      await caraPage.screenshot({ path: testInfo.outputPath('cara-reader.png') });

      for (const editor of [page, danPage]) {
        await expect.poll(async () => (await storedDocumentFiles(editor)).filter(name => name.includes('conflict')), {
          timeout: 30_000,
        }).toEqual([]);
      }
    } finally {
      await danContext.close();
      await caraContext.close();
    }
  });
});
