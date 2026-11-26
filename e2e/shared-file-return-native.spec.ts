import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test, expect } from './fixtures';
import { configureNativeRelay, idriveBin, nativeEnvironment, runIdriveJson } from './native-idrive';
import { acceptAndOpen, openProfile, waitForSharedFolderPublished } from './shared-folder.helpers';
import { chooseFileAction, getTestBlossomUrl, openListedFile } from './test-utils';

test('web and native return each other’s removed file with its latest bytes', async ({ page, relayUrl }, testInfo) => {
  test.setTimeout(300000);
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
    // The reasons a return is put off are logged at debug level.
    env: { ...nativeEnvironment(admin), RUST_LOG: 'info,iris_drive_core::shared_owner_return=debug,idrive::daemon=debug' },
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
    // The native app looks for returns every 30 seconds, and its first look
    // comes about 26 seconds after the browser is back: one look is the usual
    // 30 seconds, and this allows four. A return that needed more than one
    // look, or never came, says what each side was waiting for.
    const webSaid: string[] = [];
    const backOnline = Date.now();
    const sinceOnline = () => `${((Date.now() - backOnline) / 1000).toFixed(1)}s`;
    page.on('console', (message) => {
      if (/file return/i.test(message.text())) webSaid.push(`${sinceOnline()} ${message.text().slice(0, 240)}`);
    });
    const whatEachSideWaitedFor = async () => {
      const jobs = await page.evaluate(() => new Promise<string[]>((resolve) => {
        const open = indexedDB.open('iris-drive-file-returns');
        open.onerror = () => resolve(['could not open the return jobs']);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('jobs')) { db.close(); resolve([]); return; }
          const all = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result.map((row: { id: string; state: string; outgoing: boolean }) => `${row.outgoing ? 'out' : 'in'}:${row.id.split(':')[0].slice(0, 8)}=${row.state}`));
          };
          all.onerror = () => { db.close(); resolve(['could not read the return jobs']); };
        };
      })).catch((error) => [String(error)]);
      const native = fs.readFileSync(path.join(root, 'native-daemon.log'), 'utf8').split('\n')
        .filter((line) => /^\d{4}-\d\d-\d\dT\S+\s+(DEBUG|WARN|ERROR)\b/.test(line) && !/recv buffer clamped/.test(line))
        .slice(-30).map((line) => line.slice(0, 260));
      return `web return jobs: ${JSON.stringify(jobs)}\nweb said:\n${webSaid.join('\n')}\nnative said:\n${native.join('\n')}`;
    };
    await page.context().setOffline(false);
    await expect.poll(nativePaths, { timeout: 125000 }).not.toContain('Trip/' + renamed).catch(async (error) => {
      console.log(`The first return did not finish in ${sinceOnline()}.\n${await whatEachSideWaitedFor()}`);
      throw error;
    });
    if (Date.now() - backOnline > 45000) console.log(`The first return took ${sinceOnline()}, more than one look.\n${await whatEachSideWaitedFor()}`);
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
