import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { configureNativeRelay, runIdriveJson, irisDriveAvailable } from './native-idrive';
import { openProfile, acceptAndOpen } from './shared-folder.helpers';
import {
  flushPendingPublishes, getTestBlossomUrl, saveTextFile,
} from './test-utils';

test('reader and editor join short native invites, edit across apps, reload and receive role changes', async ({ page, browser, relayUrl }, testInfo) => {
  test.skip(!irisDriveAvailable() && !process.env.IRIS_DRIVE_BIN, 'Native Drive is required for this cross-app journey');
  test.setTimeout(180_000);
  const root = testInfo.outputPath('profiles');
  fs.mkdirSync(root, { recursive: true });
  const dirs = Object.fromEntries(['alice', 'bob', 'cara'].map((person) => [person, path.join(root, person)]));
  for (const [person, dir] of Object.entries(dirs)) {
    configureNativeRelay(dir, relayUrl);
    runIdriveJson(dir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
    runIdriveJson(dir, ['blossom-servers', 'add', getTestBlossomUrl()]);
    runIdriveJson(dir, ['init', '--label', person]);
    runIdriveJson(dir, ['publish', '--relay', relayUrl, '--timeout', '2']);
  }
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'Picnic'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Picnic', 'Plan.txt'), 'Meet at noon.');
  fs.writeFileSync(path.join(source, 'Private.txt'), 'Not shared.');
  runIdriveJson(dirs.alice!, ['import', source]);
  const { share } = runIdriveJson(dirs.alice!, ['shares', 'create', 'Picnic']);
  const inviteFor = (person: string, role: string) => {
    const evidence = runIdriveJson(dirs[person]!, ['shares', 'recipient-evidence', '--display-name', person]);
    const file = path.join(root, `${person}-evidence.json`);
    fs.writeFileSync(file, JSON.stringify(evidence));
    return { profileId: evidence.profile_id, invite: runIdriveJson(dirs.alice!, ['shares', 'invite', share.share_id, '--recipient-evidence', file, '--role', role]).invite as string };
  };
  const editor = inviteFor('bob', 'editor');
  const reader = inviteFor('cara', 'reader');
  const readerContext = await browser.newContext();
  try {
    const readerPage = await readerContext.newPage();
    await openProfile(readerPage, dirs.cara!, relayUrl);
    await acceptAndOpen(readerPage, reader.invite);
    await expect(readerPage.getByText('Private.txt', { exact: true })).toHaveCount(0);
    await expect(readerPage.getByRole('button', { name: 'New', exact: true })).toHaveCount(0);
    await readerPage.getByRole('link', { name: /^Plan\.txt\b/ }).click();
    await expect(readerPage.getByText('Meet at noon.', { exact: true })).toBeVisible();
    await expect(readerPage.getByTestId('viewer-edit')).toHaveCount(0);
    await expect(readerPage.getByTestId('viewer-push')).toHaveCount(0);
    const downloadPromise = readerPage.waitForEvent('download');
    await readerPage.getByTestId('viewer-download').click();
    const downloaded = await downloadPromise;
    expect(fs.readFileSync((await downloaded.path())!, 'utf8')).toBe('Meet at noon.');
    await readerPage.setViewportSize({ width: 390, height: 844 });
    await expect(readerPage.getByText('Meet at noon.', { exact: true })).toBeVisible();
    await openProfile(page, dirs.bob!, relayUrl);
    await acceptAndOpen(page, editor.invite);
    await page.getByRole('link', { name: /^Plan\.txt\b/ }).click();
    await page.getByTestId('viewer-edit').click();
    await page.locator('textarea').fill('Bob updated the picnic plan.');
    await saveTextFile(page, 30_000);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await flushPendingPublishes(page);
    await expect(readerPage.getByText('Bob updated the picnic plan.', { exact: true })).toBeVisible({ timeout: 30_000 });
    runIdriveJson(dirs.alice!, ['sync', '--relay', relayUrl, '--timeout', '2']);
    const exported = path.join(root, 'native-read.txt');
    runIdriveJson(dirs.alice!, ['provider', 'read', 'Picnic/Plan.txt', exported]);
    expect(fs.readFileSync(exported, 'utf8')).toBe('Bob updated the picnic plan.');
    await page.reload();
    await expect(page.getByText('Bob updated the picnic plan.', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('editor-file.png') });
    runIdriveJson(dirs.alice!, ['shares', 'role', share.share_id, editor.profileId, 'reader']);
    runIdriveJson(dirs.alice!, ['publish', '--relay', relayUrl, '--timeout', '2']);
    await expect(page.getByTestId('viewer-edit')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText('Bob updated the picnic plan.', { exact: true })).toBeVisible();
    await readerPage.screenshot({ path: testInfo.outputPath('reader-file.png') });
    runIdriveJson(dirs.alice!, ['shares', 'revoke', share.share_id, reader.profileId]);
    runIdriveJson(dirs.alice!, ['publish', '--relay', relayUrl, '--timeout', '2']);
    await expect(readerPage.getByText('You no longer have access to this folder.', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally { await readerContext.close(); }
});
