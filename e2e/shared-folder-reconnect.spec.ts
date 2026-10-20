import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { configureNativeRelay, runIdriveJson } from './native-idrive';
import { openProfile, acceptAndOpen, waitForSharedFolderPublished } from './shared-folder.helpers';
import { getTestBlossomUrl, waitForRelayConnected } from './test-utils';

test('trip collaborators add, rename and delete files while a reader reconnects and reopens an old invite', async ({ page, browser, relayUrl }, testInfo) => {
  test.setTimeout(240_000);
  const root = testInfo.outputPath('profiles');
  fs.mkdirSync(root, { recursive: true });
  const profiles = Object.fromEntries(['alice', 'bob', 'cara'].map(name => [name, path.join(root, name)]));
  for (const [name, dir] of Object.entries(profiles)) {
    configureNativeRelay(dir, relayUrl);
    runIdriveJson(dir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
    runIdriveJson(dir, ['blossom-servers', 'add', getTestBlossomUrl()]);
    runIdriveJson(dir, ['init', '--label', name]);
    runIdriveJson(dir, ['publish', '--relay', relayUrl, '--timeout', '2']);
  }
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'Trip'), { recursive: true });
  fs.writeFileSync(path.join(source, 'Trip', 'Plan.txt'), 'Train at noon.');
  fs.writeFileSync(path.join(source, 'Private.txt'), 'Private booking reference.');
  runIdriveJson(profiles.alice!, ['import', source]);
  const { share } = runIdriveJson(profiles.alice!, ['shares', 'create', 'Trip']);
  const inviteFor = (name: string, role: string) => {
    const evidence = runIdriveJson(profiles[name]!, ['shares', 'recipient-evidence', '--display-name', name]);
    const file = path.join(root, `${name}-evidence.json`);
    fs.writeFileSync(file, JSON.stringify(evidence));
    const { invite } = runIdriveJson(profiles.alice!, ['shares', 'invite', share.share_id, '--recipient-evidence', file, '--role', role]);
    return { invite, profileId: evidence.profile_id };
  };
  const editor = inviteFor('bob', 'editor');
  const reader = inviteFor('cara', 'reader');
  const readerContext = await browser.newContext();
  let networkFailures = 0;
  page.on('requestfailed', request => {
    if (networkFailures++ < 12) console.log('editor request failed', request.method(), new URL(request.url()).origin, request.failure()?.errorText);
  });
  page.on('response', response => {
    if (response.status() >= 400 && networkFailures++ < 12) console.log('editor HTTP failure', response.status(), new URL(response.url()).origin);
  });
  const uploadState = () => page.evaluate(async () => {
    const { parseRoute } = await import('/src/utils/route.ts');
    const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
    const { nostrStore } = await import('/src/nostr.ts');
    const { getUploadProgress } = await import('/src/stores/upload.ts');
    const route = parseRoute();
    const state = nostrStore.getState();
    const selected = state.selectedTree;
    const scopeBytes = new TextEncoder().encode(JSON.stringify([route.npub, route.treeName, route.path, selected?.pubkey, selected?.name, selected?.visibility]));
    const scopeDigest = await crypto.subtle.digest('SHA-256', scopeBytes);
    return {
      route: { treeName: route.treeName, path: route.path },
      rootAvailable: !!getTreeRootSync(route.npub, route.treeName)?.hash,
      selected: selected && { name: selected.name, visibility: selected.visibility },
      selectionMatchesSigner: selected?.pubkey === state.pubkey,
      scopeFingerprint: Array.from(new Uint8Array(scopeDigest)).map(value => value.toString(16).padStart(2, '0')).join(''),
      upload: getUploadProgress(),
    };
  });
  try {
    const readerPage = await readerContext.newPage();
    await openProfile(readerPage, profiles.cara!, relayUrl);
    await acceptAndOpen(readerPage, reader.invite);
    const folderUrl = readerPage.url();
    await readerContext.setOffline(true);
    await openProfile(page, profiles.bob!, relayUrl);
    await acceptAndOpen(page, editor.invite);
    const bytes = Buffer.from('Bring sandwiches and café supplies.');
    await page.locator('label[title="Add files"]:visible input[type="file"]').setInputFiles({
      name: 'Packing café.txt', mimeType: 'text/plain', buffer: bytes,
    });
    await expect(page.getByTestId('viewer-header')).toContainText('Packing café.txt');
    await page.getByTestId('viewer-rename').click();
    await page.getByPlaceholder('New name...').fill('Packing final.txt');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await expect(page.getByTestId('viewer-header')).toContainText('Packing final.txt');
    await waitForSharedFolderPublished(page, share.share_id);
    runIdriveJson(profiles.alice!, ['sync', '--relay', relayUrl, '--timeout', '2']);
    const output = path.join(root, 'native-packing.txt');
    runIdriveJson(profiles.alice!, ['provider', 'read', 'Trip/Packing final.txt', output]);
    expect(fs.readFileSync(output).equals(bytes)).toBe(true);

    await readerContext.setOffline(false);
    await waitForRelayConnected(readerPage);
    await expect(readerPage.getByRole('link', { name: /^Packing final\.txt\b/ })).toBeVisible({ timeout: 30_000 });
    await expect(readerPage.getByRole('link', { name: /^Packing café\.txt\b/ })).toHaveCount(0);
    await readerPage.getByRole('link', { name: /^Packing final\.txt\b/ }).click();
    await expect(readerPage.getByText(bytes.toString(), { exact: true })).toBeVisible();
    await readerPage.setViewportSize({ width: 390, height: 844 });
    await readerPage.screenshot({ path: testInfo.outputPath('reconnected-reader-mobile.png') });

    page.once('dialog', dialog => dialog.accept());
    await page.getByTestId('viewer-delete').click();
    await expect(page.getByRole('link', { name: /^Plan\.txt\b/ })).toBeVisible();
    await waitForSharedFolderPublished(page, share.share_id);
    await readerPage.goto(folderUrl);
    await expect(readerPage.getByRole('link', { name: /^Plan\.txt\b/ })).toBeVisible();
    await expect(readerPage.getByRole('link', { name: /^Packing final\.txt\b/ })).toHaveCount(0);
    runIdriveJson(profiles.alice!, ['sync', '--relay', relayUrl, '--timeout', '2']);
    const listing = runIdriveJson(profiles.alice!, ['provider', 'list']);
    expect(listing.entries.some((entry: { path: string }) => entry.path === 'Trip/Packing final.txt')).toBe(false);

    await readerContext.setOffline(true);
    runIdriveJson(profiles.alice!, ['shares', 'revoke', share.share_id, reader.profileId]);
    runIdriveJson(profiles.alice!, ['publish', '--relay', relayUrl, '--timeout', '2']);
    await readerContext.setOffline(false);
    await expect(readerPage.getByText('You no longer have access to this folder.', { exact: true })).toBeVisible({ timeout: 30_000 });
    const reference = reader.invite.split('/share-invite/')[1];
    await readerPage.goto(`${new URL(folderUrl).origin}/#/share-invite/${reference}`);
    await expect(readerPage.getByText('You no longer have access to this folder.', { exact: true })).toBeVisible();
    await expect(readerPage.getByTestId('share-invite-open')).toHaveCount(0);
    await expect(readerPage.getByTestId('share-invite-accept')).toHaveCount(0);
    await readerPage.screenshot({ path: testInfo.outputPath('revoked-old-invite.png') });
    await readerPage.goto(folderUrl);
    await expect(readerPage.getByText('You no longer have access to this folder.', { exact: true })).toBeVisible();
    await expect(readerPage.getByRole('link', { name: /^Plan\.txt\b/ })).toHaveCount(0);
    await readerPage.goto(`${new URL(folderUrl).origin}/#/shared-with-me`);
    await expect(readerPage.getByTestId('shared-with-me-row')).toContainText('Revoked');
    await expect(readerPage.getByTestId('shared-with-me-open')).toHaveCount(0);
  } catch (error) {
    console.log('editor upload state', JSON.stringify(await uploadState().catch(String)));
    await page.screenshot({ path: testInfo.outputPath('failed-editor.png') }).catch(() => {});
    throw error;
  } finally {
    await readerContext.close();
  }
});
