// A recovery phrase, as a person meets it: Backup says there is none and
// leads to Settings, where 12 words are shown once, two of them are typed back
// and only then is the phrase added. A fresh browser then signs in with those
// words through Sign in > Recovery phrase and finds the Drive's files.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable, fileRow, openRowMenu } from './test-utils';
import WebSocket from 'ws';
import { getPublicKey } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';

const PHONE = { width: 390, height: 844 };
const JARGON = [/npub/i, /nsec/i, /relay/i, /nostr/i, /facet/i, /epoch/i, /mnemonic/i, /bip-?39/i];

async function uploadFile(page: Page, name: string): Promise<void> {
  await expectFolderEditable(page);
  await page.getByTestId('upload-files-input').setInputFiles([{
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`kept safe ${Date.now()}`),
  }]);
  await expect(fileRow(page, name)).toBeVisible({ timeout: 60_000 });
}

/** Makes a recovery phrase in Settings and returns its words. */
async function createRecoveryPhrase(page: Page, screenshot?: (name: string) => Promise<void>): Promise<string[]> {
  const section = page.getByTestId('recovery-phrase-settings');
  await section.getByTestId('create-recovery-phrase').click();
  const words = await section.getByTestId('recovery-phrase-word').allTextContents();
  expect(words).toHaveLength(12);
  await screenshot?.('words');
  await section.getByTestId('recovery-phrase-written').click();

  const add = section.getByTestId('add-recovery-phrase');
  await screenshot?.('check');
  const inputs = section.getByTestId('recovery-phrase-check');
  await expect(inputs).toHaveCount(2);
  const positions: number[] = [];
  for (const label of await section.locator('label > span').allTextContents()) {
    positions.push(Number(label.replace('Word ', '')) - 1);
  }
  // A wrong word keeps the phrase from being added.
  await inputs.nth(0).fill(words[positions[0]] === 'zoo' ? 'abandon' : 'zoo');
  await inputs.nth(1).fill(words[positions[1]]);
  await expect(add).toBeDisabled();
  await inputs.nth(0).fill(` ${words[positions[0]].toUpperCase()} `);
  await expect(add).toBeEnabled();
  await add.click();
  await expect(section.getByTestId('recovery-phrase-status')).toContainText('Recovery phrase added on', { timeout: 30_000 });
  await expect(section.getByTestId('recovery-phrase-word')).toHaveCount(0);
  return words;
}

/** The Drive roots the relay holds from `author`: who each one's key is wrapped for. */
function rootWraps(relayUrl: string, author: string, d?: string): Promise<string[][]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(relayUrl);
    const found: string[][] = [];
    ws.on('open', () => ws.send(JSON.stringify(['REQ', 'roots', { kinds: [30078], authors: [author], ...(d ? { '#d': [d] } : {}) }])));
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message[0] === 'EVENT') {
        try {
          found.push(Object.keys(JSON.parse(message[2].content).root_key_wraps ?? {}));
        } catch {
          // Not a Drive root.
        }
      }
      if (message[0] === 'EOSE') {
        ws.close();
        resolve(found);
      }
    });
  });
}

test.describe('recovery phrase', () => {
  test('made in Settings, it signs a fresh browser in to the same Drive', async ({ page, browser, relayUrl }, testInfo) => {
    test.setTimeout(300_000);
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Recovery Test');
    await uploadFile(page, 'kept.txt');

    // Backup says there is no phrase yet and leads to making one.
    await page.goto(`${new URL(page.url()).origin}/#/settings/backup`);
    const restore = page.getByTestId('backup-restore');
    await expect(restore.getByTestId('backup-recovery-phrase')).toContainText('no recovery phrase', { timeout: 30_000 });
    await restore.getByRole('link', { name: 'Create recovery phrase' }).click();
    await expect(page).toHaveURL(/#\/settings\/account\/recovery$/);
    const section = page.getByTestId('recovery-phrase-settings');
    await expect(section).toContainText('brings your files back');
    await expect(section.getByTestId('recovery-phrase-status')).toHaveText('You have no recovery phrase yet.');
    await expect(page.getByText('Uploaded kept.txt')).toHaveCount(0, { timeout: 10_000 });
    await section.screenshot({ path: testInfo.outputPath('desktop-light-section-before.png') });

    const words = await createRecoveryPhrase(page, (name) => section.screenshot({ path: testInfo.outputPath(`desktop-light-${name}.png`) }));
    await section.screenshot({ path: testInfo.outputPath('desktop-light-section-after.png') });
    for (const word of JARGON) await expect(section).not.toContainText(word);

    // A phrase is not a device, and the words are not kept anywhere.
    await expect(page.getByTestId('user-key-row')).toHaveCount(1);
    const phrase = words.join(' ');
    expect(await page.evaluate((secret) => Object.values(localStorage).some((value) => value.includes(secret)), phrase)).toBe(false);

    await page.goto(`${new URL(page.url()).origin}/#/settings/backup`);
    await expect(restore.getByTestId('backup-recovery-phrase')).toHaveText('Your recovery phrase is set up.');

    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await prepareFreshSession(other, relayUrl);
      await other.goto(`${new URL(other.url()).origin}/#/users/existing`);
      await expect(other.getByTestId('identity-recovery-section')).toBeVisible({ timeout: 30_000 });
      await other.getByRole('button', { name: 'Recovery phrase' }).click();
      await other.getByLabel('Recovery phrase').fill(phrase);
      await other.getByRole('button', { name: 'Continue' }).click();
      await expect(other).toHaveURL(new RegExp(`#/${profileId}/main`), { timeout: 60_000 });
      await expect(fileRow(other, 'kept.txt')).toBeVisible({ timeout: 90_000 });

      // The device let in by the phrase can manage the account, as in native.
      await other.goto(`${new URL(other.url()).origin}/#/settings/account`);
      const otherSection = other.getByTestId('recovery-phrase-settings');
      await expect(otherSection.getByTestId('recovery-phrase-status')).toContainText('Recovery phrase added on', { timeout: 30_000 });
      await expect(otherSection.getByTestId('create-recovery-phrase')).toHaveText('Create a new recovery phrase');
      await expect(other.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30_000 });
    } finally {
      await fresh.close();
    }
  });

  test('brings the files back when every other device is gone', async ({ page, browser, relayUrl }) => {
    test.setTimeout(300_000);
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Lost Devices');
    await uploadFile(page, 'only-here.txt');
    await uploadFile(page, 'restore-this.txt');
    await (await openRowMenu(page, 'restore-this.txt')).getByRole('menuitem', { name: 'Delete' }).click();
    await expect(fileRow(page, 'restore-this.txt')).toHaveCount(0);
    const device = await page.evaluate(() => (window as unknown as { __nostrStore: { getState: () => { pubkey: string } } }).__nostrStore.getState().pubkey);

    await page.goto(`${new URL(page.url()).origin}/#/settings/account/recovery`);
    const phrase = (await createRecoveryPhrase(page)).join(' ');
    const recoveryKey = getPublicKey(privateKeyFromSeedWords(phrase));

    // The page says when the phrase is safe; the relays then hold this device's
    // Drive wrapped for the phrase too. Then the device is gone.
    await expect(page.getByTestId('recovery-phrase-saved')).toBeVisible({ timeout: 60_000 });
    expect((await rootWraps(relayUrl, device)).some((wraps) => wraps.includes(recoveryKey))).toBe(true);
    const trashTag = `iris-drive/${profileId}/trash/root`;
    await expect.poll(async () => (await rootWraps(relayUrl, device, trashTag)).some(wraps => wraps.includes(recoveryKey))).toBe(true);
    await page.close();

    const fresh = await browser.newContext();
    try {
      const other = await fresh.newPage();
      await prepareFreshSession(other, relayUrl);
      await other.goto(`${new URL(other.url()).origin}/#/users/existing`);
      await expect(other.getByTestId('identity-recovery-section')).toBeVisible({ timeout: 30_000 });
      await other.getByRole('button', { name: 'Recovery phrase' }).click();
      await other.getByLabel('Recovery phrase').fill(phrase);
      await other.getByRole('button', { name: 'Continue' }).click();
      await expect(other).toHaveURL(new RegExp(`#/${profileId}/main`), { timeout: 60_000 });
      await expect(fileRow(other, 'only-here.txt')).toBeVisible({ timeout: 90_000 });

      // After a reload, without the phrase, the files are still there: the device published them for itself.
      await expect.poll(async () => (await rootWraps(relayUrl, await other.evaluate(() => (window as unknown as { __nostrStore: { getState: () => { pubkey: string } } }).__nostrStore.getState().pubkey))).length, { timeout: 60_000 }).toBeGreaterThan(0);
      await other.reload();
      await expect(fileRow(other, 'only-here.txt')).toBeVisible({ timeout: 90_000 });
      await other.evaluate(() => { location.hash = '/trash'; });
      const restore = other.getByRole('button', { name: 'Restore restore-this.txt' });
      await expect(restore).toBeVisible({ timeout: 30000 });
      await restore.click();
      await expect(restore).toHaveCount(0);
      await other.evaluate(id => { location.hash = '/' + id + '/main'; }, profileId);
      await expect(fileRow(other, 'restore-this.txt')).toBeVisible();
    } finally {
      await fresh.close();
    }
  });

  test('fits a phone in dark mode', async ({ page, relayUrl }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(PHONE);
    await page.emulateMedia({ colorScheme: 'dark' });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Phone Recovery');

    await page.goto(`${new URL(page.url()).origin}/#/settings/backup`);
    const restore = page.getByTestId('backup-restore');
    await expect(restore.getByTestId('backup-recovery-phrase')).toContainText('no recovery phrase', { timeout: 30_000 });
    await restore.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('phone-dark-backup.png') });

    await page.goto(`${new URL(page.url()).origin}/#/settings/account/recovery`);
    const section = page.getByTestId('recovery-phrase-settings');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('phone-dark-section-before.png') });

    await createRecoveryPhrase(page, async (name) => {
      expect(await fits()).toBe(true);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`phone-dark-${name}.png`) });
    });
    expect(await fits()).toBe(true);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('phone-dark-section-after.png') });
  });
});
