import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { expect, test, type Page } from './fixtures';
import {
  addFileViaTreeAPI,
  clearAllStorage,
  configureBlossomServers,
  flushPendingPublishes,
  getTestBlossomUrl,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';
import {
  configureNativeRelay,
  irisDriveAvailable,
  runIdriveJson,
} from './native-idrive';

const PENDING_APPROVAL_STORAGE_KEY = 'iris:drive:pending-device-approval';
const LARGE_ROSTER_ROTATIONS = 24;

function nativeLinkInvite(profileId: string, adminAppKeyPubkey: string): string {
  const payload = {
    v: 1,
    profileId,
    adminAppKeyNpub: nip19.npubEncode(adminAppKeyPubkey),
    inviteNpub: nip19.npubEncode(getPublicKey(generateSecretKey())),
  };
  return `https://drive.iris.to/invite/${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

async function prepareJoiningBrowser(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => localStorage.setItem('hashtree:disableTestAutoCreate', '1'));
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30_000);
}

async function beginApprovalWait(page: Page): Promise<void> {
  await page.evaluate(async (storageKey) => {
    const link = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!link) throw new Error('Stored device approval request is missing');
    const { activateDriveDeviceApprovalIfApproved } = await import('/src/nostr');
    (window as any).__deviceApproval = activateDriveDeviceApprovalIfApproved(
      link.pendingApproval,
      link.appKeyNsec,
      { timeoutMs: 30_000 },
    ).then((result) => result ? ({
      profileId: result.session.profileId,
      rosterOpCount: result.session.rosterOps.length,
    }) : null);
  }, PENDING_APPROVAL_STORAGE_KEY);
}

async function finishApprovalWait(page: Page): Promise<{
  profileId: string;
  rosterOpCount: number;
}> {
  return page.evaluate(() => (window as any).__deviceApproval);
}

async function replayStoredApproval(page: Page): Promise<void> {
  await page.evaluate(async (storageKey) => {
    const link = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!link) throw new Error('Stored device approval request is missing');
    const { activateDriveDeviceApprovalIfApproved } = await import('/src/nostr');
    const result = await activateDriveDeviceApprovalIfApproved(
      link.pendingApproval,
      link.appKeyNsec,
      { timeoutMs: 10_000 },
    );
    if (!result) throw new Error('Stored approval receipt was not replayed');
  }, PENDING_APPROVAL_STORAGE_KEY);
}

async function approvalAcks(page: Page): Promise<Array<{
  id: string;
  approvalEventId: string;
  deviceAppKeyPubkey: string;
}>> {
  return page.evaluate(async () => {
    const { ndk } = await import('/src/nostr');
    const {
      KIND_NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK,
      NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE,
    } = await import('/src/drive/deviceLink');
    const events = await ndk.fetchEvents({
      kinds: [KIND_NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK],
      '#type': [NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE],
      limit: 20,
    });
    return Array.from(events).map((event) => {
      const content = JSON.parse(event.content);
      return {
        id: event.id,
        approvalEventId: content.approvalEventId,
        deviceAppKeyPubkey: content.deviceAppKeyPubkey,
      };
    });
  });
}

async function driveRootEventIdsByAuthor(
  page: Page,
  profileId: string,
  appKeyPubkey: string,
): Promise<string[]> {
  return page.evaluate(async ({ profile, author }) => {
    const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
    const { ndk } = await import('/src/nostr');
    const events = await ndk.fetchEvents({
      authors: [author],
      kinds: [KIND_DRIVE_ROOT],
      '#d': [driveRootDTag(profile, 'main')],
      limit: 20,
    });
    return Array.from(events, (event) => event.id).sort();
  }, { profile: profileId, author: appKeyPubkey });
}

function configureNativeBlossom(configDir: string): void {
  runIdriveJson(configDir, ['blossom-servers', 'remove', 'https://upload.iris.to']);
  runIdriveJson(configDir, ['blossom-servers', 'add', getTestBlossomUrl()]);
}

async function expectProfileFile(
  page: Page,
  profileId: string,
  fileName: string,
  expectedContent: string,
): Promise<void> {
  await page.goto(`/#/${profileId}/main`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await expect.poll(() => page.evaluate(async ({ profile, name }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const { getTree } = await import('/src/store');
    const root = getTreeRootSync(profile, 'main');
    if (!root) return null;
    const entry = await getTree().resolvePath(root, name).catch(() => null);
    if (!entry) return null;
    const bytes = await getTree().readFile(entry.cid).catch(() => null);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, { profile: profileId, name: fileName }), {
    timeout: 60_000,
    intervals: [500, 1_000, 2_000],
  }).toBe(expectedContent);

  expect(await page.evaluate(async (profile) => {
    const { getTreeRootSync } = await import('/src/stores');
    const { getTree } = await import('/src/store');
    const root = getTreeRootSync(profile, 'main');
    return root ? (await getTree().listDirectory(root)).map((entry) => entry.name) : [];
  }, profileId)).not.toContain('.hashtree');
}

async function expectNativeProfileFile(
  configDir: string,
  relayUrl: string,
  outputDir: string,
  fileName: string,
  expectedContent: string,
): Promise<void> {
  const output = path.join(outputDir, `read-${fileName}`);
  const deadline = Date.now() + 90_000;
  let diagnostics: unknown = null;
  while (Date.now() < deadline) {
    const sync = runIdriveJson<any>(configDir, ['sync', '--relay', relayUrl, '--timeout', '3']);
    const listing = runIdriveJson<any>(configDir, ['list']);
    const file = listing.files?.find((entry: any) => entry.path === fileName);
    diagnostics = { sync, listing };
    if (file) {
      runIdriveJson(configDir, ['provider', 'read', fileName, output]);
      if (fs.readFileSync(output, 'utf8') === expectedContent) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Native device did not read ${fileName}:\n${JSON.stringify(diagnostics, null, 2)}`);
}

test('native owner and restarted web device link quickly through a large roster with exact ACK replay', async ({
  page,
  relayUrl,
}) => {
  test.skip(!irisDriveAvailable(), 'iris-drive repo not available');
  test.setTimeout(300_000);

  const nativeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-web-link-native-'));
  const nativeFiles = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-web-link-files-'));
  try {
    const native = runIdriveJson<{ profile_id: string }>(nativeConfig, [
      'init',
      '--label',
      'Native owner',
    ]);
    configureNativeRelay(nativeConfig, relayUrl);
    configureNativeBlossom(nativeConfig);
    for (let index = 0; index < LARGE_ROSTER_ROTATIONS; index += 1) {
      runIdriveJson(nativeConfig, ['rotate-dck']);
    }
    const existingFileName = 'present-before-web-link.txt';
    const existingFileContent = 'native content that predates browser approval';
    fs.writeFileSync(path.join(nativeFiles, existingFileName), existingFileContent);
    runIdriveJson(nativeConfig, ['import', nativeFiles]);
    const initialPublish = runIdriveJson<{ published_files_root: boolean }>(nativeConfig, [
      'publish',
      '--relay',
      relayUrl,
      '--timeout',
      '2',
    ]);
    expect(initialPublish.published_files_root).toBe(true);

    await prepareJoiningBrowser(page, relayUrl);
    const link = await page.evaluate(async (storageKey) => {
      const { createDriveDeviceApprovalLink } = await import('/src/nostr');
      const created = createDriveDeviceApprovalLink({ label: 'Web browser' });
      localStorage.setItem(storageKey, JSON.stringify(created));
      return created;
    }, PENDING_APPROVAL_STORAGE_KEY);

    // Prove pending request recovery across a real browser restart before approval.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, 60_000);
    await waitForRelayConnected(page, 30_000);
    await beginApprovalWait(page);
    await page.waitForTimeout(250);

    const startedAt = Date.now();
    const approval = runIdriveJson<{
      approved_app_key_npub: string;
      published_approval_events: number;
      approval_publish_error: string | null;
    }>(nativeConfig, ['app-keys', 'approve', link.url]);
    const activated = await finishApprovalWait(page);
    const approvalToActivationMs = Date.now() - startedAt;

    expect(approval.approved_app_key_npub).toBe(link.appKeyNpub);
    expect(approval.approval_publish_error).toBeNull();
    expect(approval.published_approval_events).toBeGreaterThan(LARGE_ROSTER_ROTATIONS);
    expect(activated.profileId).toBe(native.profile_id);
    expect(activated.rosterOpCount).toBeGreaterThan(LARGE_ROSTER_ROTATIONS);
    expect(approvalToActivationMs).toBeLessThan(10_000);

    await expectProfileFile(
      page,
      native.profile_id,
      existingFileName,
      existingFileContent,
    );
    await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('user-key-row').filter({ hasText: 'Native owner' })).toHaveCount(1);
    await expect(page.getByTestId('user-key-row').filter({ hasText: 'Web browser' })).toHaveCount(1);

    const firstAcks = await approvalAcks(page);
    expect(firstAcks).toHaveLength(1);
    expect(firstAcks[0].deviceAppKeyPubkey).toBe(link.appKeyPubkey);
    expect(firstAcks[0].approvalEventId).toMatch(/^[0-9a-f]{64}$/);

    // Joining an existing profile is adoption, not a write. In particular, the
    // browser must not race remote-root discovery by publishing a fresh empty root.
    await page.waitForTimeout(6_000);
    expect(await driveRootEventIdsByAuthor(page, native.profile_id, link.appKeyPubkey)).toEqual([]);

    // The inverse direction exercises the real linked-AppKey path: the browser
    // publishes a causally observed root and uploads its blocks, then the native
    // owner merges it and reads the exact bytes.
    const webFileName = 'created-on-linked-web.txt';
    const webFileContent = 'web content visible on the native/iOS side';
    await page.goto(`/#/${native.profile_id}/main`, { waitUntil: 'domcontentloaded' });
    const webRoot = await addFileViaTreeAPI(page, [], webFileName, webFileContent);
    expect(webRoot).toMatch(/^[0-9a-f]{64}$/);
    await flushPendingPublishes(page);
    await expect.poll(
      () => driveRootEventIdsByAuthor(page, native.profile_id, link.appKeyPubkey),
      { timeout: 30_000, intervals: [500, 1_000, 2_000] },
    ).not.toEqual([]);
    await expectNativeProfileFile(
      nativeConfig,
      relayUrl,
      nativeFiles,
      webFileName,
      webFileContent,
    );

    // A restarted device must replay the exact receipt ACK until the owner observes it.
    await page.waitForTimeout(1_100);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, 60_000);
    await waitForRelayConnected(page, 30_000);
    await replayStoredApproval(page);
    await expectProfileFile(
      page,
      native.profile_id,
      existingFileName,
      existingFileContent,
    );
    const replayedAcks = await approvalAcks(page);
    expect(replayedAcks).toHaveLength(2);
    expect(new Set(replayedAcks.map((ack) => ack.approvalEventId))).toEqual(
      new Set([firstAcks[0].approvalEventId]),
    );

    // Every CLI invocation reloads native state, so this also covers owner restart recovery.
    runIdriveJson(nativeConfig, ['sync', '--relay', relayUrl, '--timeout', '3']);
    const status = runIdriveJson<any>(nativeConfig, ['status']);
    expect(status.profile.roster_size).toBe(2);
    expect(status.profile.pending_device_approval_receipt_count).toBe(0);
    expect(status.profile.profile.profile_roster_op_count).toBeGreaterThan(LARGE_ROSTER_ROTATIONS);
  } finally {
    fs.rmSync(nativeConfig, { recursive: true, force: true });
    fs.rmSync(nativeFiles, { recursive: true, force: true });
  }
});

test('web owner approves a native device that durably activates and acknowledges', async ({
  page,
  relayUrl,
}) => {
  test.skip(!irisDriveAvailable(), 'iris-drive repo not available');
  test.setTimeout(180_000);

  const nativeConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-drive-native-link-web-'));
  try {
    await prepareJoiningBrowser(page, relayUrl);
    const owner = await page.evaluate(async () => {
      const { createDriveProfile, getCurrentNostrIdentitySession } = await import('/src/nostr');
      const created = await createDriveProfile({ name: 'Web owner' });
      const session = getCurrentNostrIdentitySession();
      if (!session) throw new Error('Web owner session was not created');
      return { profileId: created.profileId, appKeyPubkey: session.appKeyPubkey };
    });
    await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('device-approval-input')).toBeVisible({ timeout: 30_000 });

    const request = runIdriveJson<{
      current_app_key_npub: string;
      app_key_link_request: { url: string };
    }>(nativeConfig, [
      'link',
      nativeLinkInvite(owner.profileId, owner.appKeyPubkey),
      '--label',
      'Native device',
    ]);
    configureNativeRelay(nativeConfig, relayUrl);

    const startedAt = Date.now();
    await page.getByTestId('device-approval-input').fill(request.app_key_link_request.url);
    await page.getByTestId('approve-device-request').click();
    await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 30_000 });
    const rosterTimes = await page.evaluate(() => (
      JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null')
        ?.rosterOps.map((op: any) => op.content.created_at) ?? []
    ));
    expect(rosterTimes).toHaveLength(4);
    expect(rosterTimes.every((time: number, index: number) => (
      index === 0 || time > rosterTimes[index - 1]
    ))).toBe(true);

    const sync = runIdriveJson<{ device_approval_receipts_applied: number }>(nativeConfig, [
      'sync',
      '--relay',
      relayUrl,
      '--timeout',
      '3',
    ]);
    expect(sync.device_approval_receipts_applied).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const status = runIdriveJson<any>(nativeConfig, ['status']);
    expect(status.profile.authorization_state).toBe('authorized');
    expect(status.profile.roster_size).toBe(2);
    expect(status.current_app_key_npub).toBe(request.current_app_key_npub);

    const nativePubkey = nip19.decode(request.current_app_key_npub).data;
    await expect.poll(() => approvalAcks(page), {
      timeout: 10_000,
      intervals: [100, 250, 500],
    }).toEqual([
      expect.objectContaining({
        approvalEventId: expect.stringMatching(/^[0-9a-f]{64}$/),
        deviceAppKeyPubkey: nativePubkey,
      }),
    ]);
  } finally {
    fs.rmSync(nativeConfig, { recursive: true, force: true });
  }
});
