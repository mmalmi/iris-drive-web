import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test, expect } from './fixtures';
import { configureNativeRelay, idriveBin, runIdriveJson } from './native-idrive';
import { acceptAndOpen, openProfile, waitForSharedFolderPublished } from './shared-folder.helpers';
import { chooseFileAction, getTestBlossomUrl, openListedFile } from './test-utils';

test('web and native return each other’s removed file with its latest bytes', async ({ page, relayUrl }, testInfo) => {
  test.setTimeout(240000);
  const root = testInfo.outputPath('profiles');
  const admin = path.join(root, 'admin');
  const member = path.join(root, 'member');
  fs.mkdirSync(root, { recursive: true });
  for (const [dir, label] of [
    [admin, 'Folder admin'],
    [member, 'Member'],
  ]) {
    configureNativeRelay(dir, relayUrl);
    runIdriveJson(dir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
    runIdriveJson(dir, ['blossom-servers', 'add', getTestBlossomUrl()]);
    runIdriveJson(dir, ['init', '--label', label]);
    runIdriveJson(dir, ['publish', '--relay', relayUrl, '--timeout', '2']);
  }
  const nativeSource = path.join(root, 'native-source');
  const guestSource = path.join(root, 'member-source');
  fs.mkdirSync(path.join(nativeSource, 'Trip'), { recursive: true });
  fs.mkdirSync(guestSource);
  fs.writeFileSync(path.join(nativeSource, 'Trip', 'Plan.txt'), 'Train at noon');
  fs.writeFileSync(path.join(guestSource, 'Keep.txt'), 'Personal file');
  runIdriveJson(admin, ['import', nativeSource]);
  runIdriveJson(member, ['import', guestSource]);
  runIdriveJson(member, ['publish', '--relay', relayUrl, '--timeout', '2']);
  const { share } = runIdriveJson(admin, ['shares', 'create', 'Trip']);
  const evidence = runIdriveJson(member, ['shares', 'recipient-evidence', '--display-name', 'Member']);
  const evidencePath = path.join(root, 'member-evidence.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  const { invite } = runIdriveJson(admin, [
    'shares',
    'invite',
    share.share_id,
    '--recipient-evidence',
    evidencePath,
    '--role',
    'editor',
  ]);
  await openProfile(page, member, relayUrl);
  await acceptAndOpen(page, invite);
  const shareUrl = page.url();
  const personalUrl = new URL(shareUrl).origin + '/#/' + evidence.profile_id + '/main';
  const log = fs.openSync(path.join(root, 'native-daemon.log'), 'w');
  const daemon = spawn(idriveBin(), ['daemon', '--relay', relayUrl, '--no-gateway'], {
    env: { ...process.env, IRIS_DRIVE_CONFIG_DIR: admin },
    stdio: ['ignore', log, log],
  });
  try {
    const webName = 'From browser.txt';
    const renamed = 'Updated recording.txt';
    await page
      .getByTestId('upload-files-input')
      .setInputFiles({ name: webName, mimeType: 'text/plain', buffer: Buffer.from('Original from web') });
    await waitForSharedFolderPublished(page, share.share_id, { has: [webName] });
    function nativePaths(): string[] {
      return runIdriveJson(admin, ['provider', 'list']).entries.map((e: { path: string }) => e.path);
    }
    await expect.poll(nativePaths, { timeout: 40000 }).toContain('Trip/' + webName);
    runIdriveJson(admin, ['provider', 'rename', 'Trip/' + webName, 'Trip/' + renamed]);
    const edited = 'Edited on native. The latest recording has café at noon.';
    const input = path.join(root, 'edited-input.txt');
    fs.writeFileSync(input, edited);
    runIdriveJson(admin, ['provider', 'write', 'Trip/' + renamed, input]);
    await expect(page.getByRole('link', { name: new RegExp('^Updated recording') })).toBeVisible({ timeout: 40000 });
    await page.context().setOffline(true);
    const pending = runIdriveJson(admin, ['provider', 'delete', 'Trip/' + renamed]);
    expect(pending.return_request).toBeTruthy();
    expect(nativePaths()).toContain('Trip/' + renamed);
    await page.context().setOffline(false);
    await expect.poll(nativePaths, { timeout: 90000 }).not.toContain('Trip/' + renamed);
    await page.goto(personalUrl);
    await openListedFile(page, renamed);
    await expect(page.getByText(edited, { exact: true })).toBeVisible();

    const nativeName = 'From native.txt';
    fs.writeFileSync(input, 'Originally native');
    runIdriveJson(admin, ['provider', 'write', 'Trip/' + nativeName, input]);
    await page.goto(shareUrl);
    await expect(page.getByRole('link', { name: /^From native/ })).toBeVisible({ timeout: 40000 });
    const latest = 'Final revision from the web. Exact bytes: öä.';
    await page
      .getByTestId('upload-files-input')
      .setInputFiles({ name: nativeName, mimeType: 'text/plain', buffer: Buffer.from(latest) });
    await waitForSharedFolderPublished(page, share.share_id, { has: [nativeName] });
    await openListedFile(page, nativeName);
    await expect(page.getByText(latest, { exact: true })).toBeVisible();
    await chooseFileAction(page, 'viewer-delete');
    await expect(page.getByText(/Removal requested/)).toBeVisible();
    await expect.poll(nativePaths, { timeout: 90000 }).toContain(nativeName);
    await expect.poll(nativePaths, { timeout: 60000 }).not.toContain('Trip/' + nativeName);
    const output = path.join(root, 'native-return.txt');
    runIdriveJson(admin, ['provider', 'read', nativeName, output]);
    expect(fs.readFileSync(output).equals(Buffer.from(latest))).toBe(true);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGTERM');
      const timeout = setTimeout(() => daemon.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timeout);
    }
    fs.closeSync(log);
  }
});
