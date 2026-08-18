import { expect, test, type Browser, type BrowserContext, type Page } from './fixtures';
import {
  addFileViaTreeAPI,
  clearAllStorage,
  configureBlossomServers,
  enableOthersPool,
  flushPendingPublishes,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForCurrentDirectoryEntries,
  waitForFipsConnection,
  waitForRelayConnected,
} from './test-utils.js';
import {
  applyMainActionMutations,
  pauseProfileDriveRootUpdates,
  resumeProfileDriveRootUpdates,
  type MainActionMutation,
} from './profile-drive-actions.js';

async function prepareDriveInstance(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30000);
}

async function createAdminDriveUser(page: Page): Promise<string> {
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('generate-new-account').click();
  await expect(page.getByTestId('identity-create-name')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('identity-create-name').fill('Drive Admin');
  await page.getByTestId('create-new-after-recovery-miss').click();

  const profileIdHandle = await page.waitForFunction(() => {
    const session = (window as unknown as {
      __nostrStore?: { getState?: () => { npub?: string } };
    });
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.status === 'active' && stored?.profileId && session.__nostrStore?.getState?.().npub
      ? stored.profileId
      : null;
  }, undefined, { timeout: 30000 });
  const profileId = await profileIdHandle.jsonValue() as string;
  await page.waitForFunction(() => window.location.hash.includes('/main'), undefined, { timeout: 30000 });
  return profileId;
}

async function expectDeviceAdminBadges(page: Page, expectedRows: number, expectedAdmins: number): Promise<void> {
  const rows = page.getByTestId('user-key-row');
  const keyList = page.getByTestId('user-settings-keys');
  const statuses = page.getByTestId('user-key-status');
  await expect(rows).toHaveCount(expectedRows, { timeout: 30000 });
  await expect(keyList.locator('.badge')).toHaveCount(expectedAdmins);
  if (expectedAdmins > 0) {
    await expect(keyList.locator('.badge')).toHaveText(Array.from({ length: expectedAdmins }, () => 'Admin'));
  }
  await expect(statuses).toHaveCount(expectedRows);
  await expect(statuses.nth(0)).toHaveAttribute('data-device-status', 'online');
  await expect(keyList).not.toContainText('Online');
  await expect(keyList).not.toContainText('Offline');
  await expect(keyList).not.toContainText('Current');
  await expect(keyList).not.toContainText('Write');
  await expect(keyList).not.toContainText('Recovery');
  await expect(keyList).not.toContainText('Decrypt');
  await expect(keyList).not.toContainText('Receive keys');
}

async function expectPrivateDeviceLabel(label: ReturnType<Page['locator']>): Promise<void> {
  await expect(label).not.toHaveText(/^(Connected browser|Linked browser|Device)$/);
  await expect(label).toHaveText(/.+/);
}

async function expectDeviceLabels(page: Page, count: number): Promise<void> {
  const rows = page.getByTestId('user-key-row');
  await expect(rows).toHaveCount(count, { timeout: 30000 });
  for (let index = 0; index < count; index += 1) {
    await expectPrivateDeviceLabel(rows.nth(index).locator('strong'));
  }
}

async function expectLinkedDeviceLabel(page: Page): Promise<void> {
  const remoteLabel = page.getByTestId('user-key-row').nth(1).locator('strong');
  await expect(remoteLabel).not.toHaveText(/^(This device|Linked device)$/);
  await expectPrivateDeviceLabel(remoteLabel);
}

async function expectOwnerSettingsReady(page: Page, expectedRows = 1): Promise<void> {
  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-settings-summary')).toHaveCount(0);
  await expect(page.getByTestId('user-settings-devices').getByRole('heading', { name: 'Devices' })).toHaveCount(0);
  await expect(page.getByTestId('device-approval-section')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('device-approval-input')).toBeVisible();
  await expect(page.getByTestId('user-add-device-section')).toHaveCount(0);
  await expectDeviceAdminBadges(page, expectedRows, 1);
  await expectDeviceLabels(page, expectedRows);
}

async function createDeviceApprovalRequest(page: Page): Promise<string> {
  await page.goto('/#/users', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('add-existing-profile')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('add-existing-profile').click();
  await expect(page).toHaveURL(/#\/users\/existing/);
  await expect(page.getByTestId('device-approval-request-section')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('heading', { name: 'Request Link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy Request Link' })).toBeVisible({ timeout: 10000 });
  const qrCode = page.getByTestId('device-approval-qr');
  await expect(qrCode).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => qrCode.getAttribute('src'), { timeout: 10000 }).toMatch(/^data:image\/png;base64,/);
  const approvalUrl = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:drive:pending-device-approval') ?? 'null') as { url?: string } | null;
    return stored?.url ?? '';
  });
  expect(approvalUrl).toMatch(/^https:\/\/drive\.iris\.to\/approve-device\//);
  expect(approvalUrl).not.toContain('app_key=');
  return approvalUrl;
}

async function approveDeviceApprovalRequest(page: Page, approvalUrl: string, expectedRowsAfterApproval = 2): Promise<void> {
  await expectOwnerSettingsReady(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/#\/settings\/user/);
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-settings-summary')).toHaveCount(0);
  await expect(page.getByTestId('user-settings-devices').getByRole('heading', { name: 'Devices' })).toHaveCount(0);
  await expectDeviceAdminBadges(page, 1, 1);
  await expectDeviceLabels(page, 1);
  await expect(page.getByTestId('device-approval-section')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('user-add-device-section')).toHaveCount(0);
  await page.getByTestId('device-approval-input').fill(approvalUrl);
  await page.getByTestId('approve-device-request').click();
  await expectDeviceAdminBadges(page, expectedRowsAfterApproval, 1);
  await expectPrivateDeviceLabel(page.getByTestId('user-key-row').nth(0).locator('strong'));
  await expectLinkedDeviceLabel(page);
  await expect(page.getByTestId('user-key-row').nth(1).getByTestId('user-grant-admin')).toBeVisible();
  await expect(page.getByTestId('user-key-row').nth(1).getByTestId('user-revoke-admin')).toHaveCount(0);
}

async function activateApprovedDevice(page: Page, profileId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const { getCurrentNostrIdentitySession } = await import('/src/nostr');
    const session = getCurrentNostrIdentitySession();
    const pubkey = (window as any).__nostrStore?.getState?.().pubkey;
    return {
      profileId: session?.profileId,
      status: session?.status,
      liveMatchesStoredAppKey: !!session?.appKeyPubkey && pubkey === session.appKeyPubkey,
    };
  }), { timeout: 60000, intervals: [500, 1000, 2000] }).toEqual({
    profileId,
    status: 'active',
    liveMatchesStoredAppKey: true,
  });

  await page.goto('/#/settings/user', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('user-settings-panel')).toBeVisible({ timeout: 30000 });
  await expectDeviceAdminBadges(page, 2, 1);
  await expectPrivateDeviceLabel(page.getByTestId('user-key-row').nth(0).locator('strong'));
  await expectLinkedDeviceLabel(page);
  await expectAppliedApprovalAck(page);
}

async function expectAppliedApprovalAck(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(async () => {
    const { getCurrentNostrIdentitySession, ndk } = await import('/src/nostr');
    const {
      KIND_NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK,
      NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE,
    } = await import('/src/drive/deviceLink');
    const session = getCurrentNostrIdentitySession();
    if (!session) return null;
    const events = Array.from(await ndk.fetchEvents({
      authors: [session.appKeyPubkey],
      kinds: [KIND_NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK],
      '#type': [NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE],
      limit: 10,
    }));
    const event = events.find((candidate) => candidate.tags.some((tag) => (
      tag[0] === 'type' && tag[1] === NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE
    )));
    if (!event) return null;
    const content = JSON.parse(event.content);
    return {
      signerMatchesDevice: event.pubkey === content.deviceAppKeyPubkey,
      approvalEventId: content.approvalEventId,
    };
  }), { timeout: 10000, intervals: [100, 250, 500] }).toEqual({
    signerMatchesDevice: true,
    approvalEventId: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
}

async function fetchRelayDriveRootHashes(page: Page, relayUrl: string): Promise<Array<{
  id: string;
  pubkey: string;
  created_at: number;
  root_hash: string | null;
  d: string | null;
}>> {
  return page.evaluate(async (relay: string) => {
    const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    if (!profileId) return [];
    const dTag = driveRootDTag(profileId, 'main');

    return new Promise<Array<{
      id: string;
      pubkey: string;
      created_at: number;
      root_hash: string | null;
      d: string | null;
    }>>((resolve, reject) => {
      const events: Array<{
        id: string;
        pubkey: string;
        created_at: number;
        root_hash: string | null;
        d: string | null;
      }> = [];
      const subId = `drive-root-${Math.random().toString(36).slice(2)}`;
      const socket = new WebSocket(relay);
      const timeout = window.setTimeout(() => {
        socket.close();
        resolve(events);
      }, 3000);

      socket.onopen = () => {
        socket.send(JSON.stringify(['REQ', subId, {
          kinds: [KIND_DRIVE_ROOT],
          '#d': [dTag],
          limit: 50,
        }]));
      };
      socket.onmessage = (message) => {
        const data = JSON.parse(String(message.data));
        if (data[0] === 'EVENT') {
          const event = data[2];
          let rootHash: string | null = null;
          try {
            rootHash = JSON.parse(event.content)?.root_hash ?? null;
          } catch {
            rootHash = null;
          }
          events.push({
            id: event.id,
            pubkey: event.pubkey,
            created_at: event.created_at,
            root_hash: rootHash,
            d: event.tags?.find((tag: string[]) => tag[0] === 'd')?.[1] ?? null,
          });
        }
        if (data[0] === 'EOSE') {
          window.clearTimeout(timeout);
          socket.send(JSON.stringify(['CLOSE', subId]));
          socket.close();
          resolve(events);
        }
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error(`relay websocket error: ${relay}`));
      };
    });
  }, relayUrl);
}

async function waitForPublishedProfileRoot(page: Page, relayUrl: string, expectedRootHash: string): Promise<void> {
  const hasRoot = async () => page.evaluate(async (expectedHash: string) => {
    const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
    const { ndk } = await import('/src/nostr');
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    if (!profileId) return false;
    const events = Array.from(await ndk.fetchEvents({
      kinds: [KIND_DRIVE_ROOT],
      '#d': [driveRootDTag(profileId, 'main')],
      limit: 50,
    }));
    return events.some((event) => {
      try {
        return JSON.parse(event.content)?.root_hash === expectedHash;
      } catch {
        return false;
      }
    });
  }, expectedRootHash);

  try {
    await expect.poll(hasRoot, { timeout: 30000, intervals: [500, 1000, 2000] }).toBe(true);
  } catch (error) {
    const relayEvents = await fetchRelayDriveRootHashes(page, relayUrl).catch((relayError) => [{
      id: 'relay-error',
      pubkey: String(relayError),
      created_at: 0,
      root_hash: null,
      d: null,
    }]);
    const diagnostics = await page.evaluate(async (expectedHash: string) => {
      const { driveRootDTag, KIND_DRIVE_ROOT } = await import('/src/drive/protocol');
      const { getCurrentNostrIdentitySession, isOwnTree, ndk } = await import('/src/nostr');
      const { parseRoute } = await import('/src/utils/route.ts');
      const { treeRootRegistry } = await import('/src/TreeRootRegistry');
      const { toHex } = await import('/src/lib/nhash.ts');
      const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      const session = getCurrentNostrIdentitySession();
      const state = (window as any).__nostrStore?.getState?.();
      const route = parseRoute();
      const profileId = stored?.profileId ?? session?.profileId ?? '';
      const record = profileId ? treeRootRegistry.getByKey(`${profileId}/main`) : null;
      const events = profileId
        ? Array.from(await ndk.fetchEvents({
          kinds: [KIND_DRIVE_ROOT],
          '#d': [driveRootDTag(profileId, 'main')],
          limit: 50,
        }))
        : [];
      return {
        expectedHash,
        hash: window.location.hash,
        route,
        isOwnTree: isOwnTree(),
        session: session ? {
          profileId: session.profileId,
          status: session.status,
          appKeyPubkey: session.appKeyPubkey,
        } : null,
        state: state ? {
          pubkey: state.pubkey,
          npub: state.npub,
          isLoggedIn: state.isLoggedIn,
          connectedRelays: state.connectedRelays,
        } : null,
        mainNdkRelays: Array.from(ndk.pool.relays.values()).map((relay: any) => ({
          url: relay.url,
          connected: relay.connectivity?.connected === true,
        })),
        workerRelayStats: await (window as any).__getWorkerAdapter?.()?.getRelayStats?.().catch((workerError: unknown) => ({
          error: String(workerError),
        })),
        record: record ? {
          hash: toHex(record.hash),
          key: record.key ? toHex(record.key) : null,
          dirty: record.dirty,
          source: record.source,
          updatedAt: record.updatedAt,
        } : null,
        events: events.map((event) => {
          try {
            return JSON.parse(event.content)?.root_hash ?? null;
          } catch {
            return null;
          }
        }),
      };
    }, expectedRootHash).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nPublish diagnostics:\n${JSON.stringify({ ...diagnostics, relayEvents }, null, 2)}`);
  }
}

async function gotoMain(page: Page): Promise<void> {
  const profileId = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    return stored?.profileId ?? '';
  });
  expect(profileId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto(`/#/${profileId}/main`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-testid="file-list"]').first()).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.evaluate(async () => {
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    return !!getCurrentRootCid()?.hash;
  }), { timeout: 30000, intervals: [500, 1000, 2000] }).toBe(true);
}

async function writeMainFileAndPublish(page: Page, relayUrl: string, filename: string, content: string): Promise<void> {
  const rootHash = await addFileViaTreeAPI(page, [], filename, content);
  expect(rootHash).toMatch(/^[a-f0-9]{64}$/);
  await flushAndWaitForCurrentProfileRoot(page, relayUrl);
}

async function currentPublishedProfileRootHash(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const { toHex } = await import('/src/lib/nhash.ts');
    const { getCurrentNostrIdentitySession } = await import('/src/nostr');
    const { profileDriveProjection } = await import('/src/drive/profileDriveProjection.ts');
    const { treeRootRegistry } = await import('/src/TreeRootRegistry');
    const session = getCurrentNostrIdentitySession();
    if (!session) return null;
    const record = treeRootRegistry.get(session.profileId, 'main');
    if (!record || record.dirty) return null;
    const contribution = profileDriveProjection.contributionRoot(
      session.profileId,
      'main',
      session.appKeyPubkey,
    );
    return contribution ? toHex(contribution.hash) : null;
  });
}

async function flushAndWaitForCurrentProfileRoot(page: Page, relayUrl: string): Promise<string> {
  await flushPendingPublishes(page);
  await expect.poll(
    () => currentPublishedProfileRootHash(page),
    { timeout: 30000, intervals: [250, 500, 1000, 2000] },
  ).toMatch(/^[a-f0-9]{64}$/);
  const rootHash = await currentPublishedProfileRootHash(page);
  expect(rootHash).toMatch(/^[a-f0-9]{64}$/);
  await waitForPublishedProfileRoot(page, relayUrl, rootHash!);
  return rootHash!;
}

async function discardHydratedMainRootBeforeSettingsApproval(page: Page, profileId: string): Promise<void> {
  await expectOwnerSettingsReady(page);
  await page.evaluate(async ({ id }) => {
    const { treeRootRegistry } = await import('/src/TreeRootRegistry');
    const { profileDriveProjection } = await import('/src/drive/profileDriveProjection.ts');
    treeRootRegistry.delete(id, 'main');
    profileDriveProjection.clear(id, 'main');
  }, { id: profileId });
  expect(await page.evaluate(({ id }) => {
    const roots = JSON.parse(localStorage.getItem('hashtree:localRootCache') ?? '{}');
    return roots[`${id}/main`] ?? null;
  }, { id: profileId })).toBeNull();
}

async function readMainFileContent(page: Page, filename: string): Promise<string | null> {
  return page.evaluate(async (target: string) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { getCurrentRootCid } = await import('/src/actions/route.ts');
    const rootCid = getCurrentRootCid();
    if (!rootCid) return null;
    const entry = await getTree().resolvePath(rootCid, target.split('/').filter(Boolean)).catch(() => null);
    if (!entry?.cid || entry.type === LinkType.Dir) return null;
    const bytes = await getTree().readFile(entry.cid).catch(() => null);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, filename);
}

async function profileDriveRootDiagnostics(page: Page, relayUrl: string): Promise<unknown> {
  const relayEvents = await fetchRelayDriveRootHashes(page, relayUrl).catch((relayError) => [{
    id: 'relay-error',
    pubkey: String(relayError),
    created_at: 0,
    root_hash: null,
    d: null,
  }]);
  return page.evaluate(async () => {
    const { getTreeRootSync } = await import('/src/stores');
    const { driveRootDTag, KIND_DRIVE_ROOT, parseDriveRootEventForDevice, parseDriveRootEventPreview } = await import('/src/drive/protocol');
    const { getSecretKey, ndk } = await import('/src/nostr');
    const { treeRootRegistry } = await import('/src/TreeRootRegistry');
    const toHex = (bytes?: Uint8Array): string | undefined => bytes
      ? Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
      : undefined;
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    const driveId = 'main';
    const key = `${profileId}/${driveId}`;
    const secretKey = getSecretKey();
    const record = treeRootRegistry.getByKey(key);
    const currentRoot = getTreeRootSync(profileId, driveId);
    const events = profileId
      ? Array.from(await ndk.fetchEvents({
        kinds: [KIND_DRIVE_ROOT],
        '#d': [driveRootDTag(profileId, driveId)],
        limit: 20,
      }))
      : [];
    return {
      profileId,
      appKeyPubkey: stored?.appKeyPubkey,
      rosterOps: stored?.rosterOps?.length ?? 0,
      registry: record ? {
        hash: toHex(record.hash),
        key: toHex(record.key),
        updatedAt: record.updatedAt,
        dirty: record.dirty,
        source: record.source,
      } : null,
      currentRoot: currentRoot ? {
        hash: toHex(currentRoot.hash),
        key: toHex(currentRoot.key),
      } : null,
      events: events.map((event) => {
        const raw = event.rawEvent();
        let preview: unknown = null;
        let readable: unknown = null;
        try {
          preview = parseDriveRootEventPreview(raw);
        } catch (error) {
          preview = String(error);
        }
        if (secretKey) {
          try {
            const parsed = parseDriveRootEventForDevice(raw, secretKey);
            readable = {
              hash: toHex(parsed.root.hash),
              hasKey: !!parsed.root.key,
            };
          } catch (error) {
            readable = String(error);
          }
        }
        return {
          id: raw.id,
          pubkey: raw.pubkey,
          created_at: raw.created_at,
          kind: raw.kind,
          sig: raw.sig ? `${raw.sig.slice(0, 12)}...${raw.sig.slice(-12)}` : null,
          d: raw.tags?.find((tag) => tag[0] === 'd')?.[1] ?? null,
          contentRootHash: (() => {
            try {
              return JSON.parse(raw.content)?.root_hash ?? null;
            } catch {
              return null;
            }
          })(),
          preview,
          readable,
        };
      }),
    };
  }).then((diagnostics) => ({ ...diagnostics, relayEvents }));
}

async function expectMainFileContent(page: Page, relayUrl: string, filename: string, expected: string): Promise<void> {
  try {
    await expect.poll(
      () => readMainFileContent(page, filename),
      { timeout: 60000, intervals: [1000, 2000, 3000] },
    ).toBe(expected);
    if (!filename.includes('/')) await waitForCurrentDirectoryEntries(page, [filename], 10000);
  } catch (error) {
    const diagnostics = await profileDriveRootDiagnostics(page, relayUrl).catch((diagnosticError) => ({
      diagnosticError: String(diagnosticError),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function expectMainFileMissing(page: Page, relayUrl: string, filename: string): Promise<void> {
  try {
    await expect.poll(
      () => readMainFileContent(page, filename),
      { timeout: 60000, intervals: [500, 1000, 2000, 3000] },
    ).toBeNull();
  } catch (error) {
    const diagnostics = await profileDriveRootDiagnostics(page, relayUrl).catch((diagnosticError) => ({
      diagnosticError: String(diagnosticError),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function mainFileContentsWithPrefix(page: Page, prefix: string): Promise<string[]> {
  return page.evaluate(async (targetPrefix: string) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { directoryEntriesStore } = await import('/src/stores/directoryEntries.ts');
    let entries: Array<{
      name: string;
      cid: { hash: Uint8Array; key?: Uint8Array };
      type: number;
    }> = [];
    const unsubscribe = directoryEntriesStore.subscribe((state) => { entries = state.entries; });
    unsubscribe();
    const contents: string[] = [];
    for (const entry of entries) {
      if (!entry.name.startsWith(targetPrefix) || entry.type === LinkType.Dir) continue;
      const bytes = await getTree().readFile(entry.cid);
      if (bytes) contents.push(new TextDecoder().decode(bytes));
    }
    return contents.sort();
  }, prefix);
}

async function expectMainContentsWithPrefix(
  page: Page,
  relayUrl: string,
  prefix: string,
  expected: string[],
): Promise<void> {
  try {
    await expect.poll(
      () => mainFileContentsWithPrefix(page, prefix),
      { timeout: 60000, intervals: [500, 1000, 2000, 3000] },
    ).toEqual([...expected].sort());
  } catch (error) {
    const diagnostics = await profileDriveRootDiagnostics(page, relayUrl).catch((diagnosticError) => ({
      diagnosticError: String(diagnosticError),
    }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nDiagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
  }
}

async function mutateMainWithActionsAndPublish(
  page: Page,
  relayUrl: string,
  mutations: MainActionMutation[],
): Promise<void> {
  await applyMainActionMutations(page, mutations);
  await flushAndWaitForCurrentProfileRoot(page, relayUrl);
}

async function expectLinkedBrowsersCanExchangeEdits(owner: Page, linked: Page, relayUrl: string): Promise<void> {
  await gotoMain(owner);
  await gotoMain(linked);
  await enableOthersPool(owner, 6);
  await enableOthersPool(linked, 6);
  await waitForFipsConnection(owner, 30000);
  await waitForFipsConnection(linked, 30000);

  await writeMainFileAndPublish(linked, relayUrl, 'linked-browser-edit.txt', 'from linked browser');
  await gotoMain(owner);
  await expectMainFileContent(owner, relayUrl, 'linked-browser-edit.txt', 'from linked browser');

  await writeMainFileAndPublish(owner, relayUrl, 'owner-browser-edit.txt', 'from owner browser');
  await gotoMain(linked);
  await expectMainFileContent(linked, relayUrl, 'owner-browser-edit.txt', 'from owner browser');

  await gotoMain(owner);
  await mutateMainWithActionsAndPublish(owner, relayUrl, [{
    type: 'write',
    path: 'delete-across-devices.txt',
    content: 'delete this from linked browser',
  }]);
  await gotoMain(linked);
  await expectMainFileContent(
    linked,
    relayUrl,
    'delete-across-devices.txt',
    'delete this from linked browser',
  );
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'delete',
    path: 'delete-across-devices.txt',
  }]);
  await gotoMain(owner);
  await expectMainFileMissing(owner, relayUrl, 'delete-across-devices.txt');

  // A metadata-free merged root is what Web edits. Publishing a later,
  // unrelated change must re-layer the linked AppKey's retained tombstone.
  await gotoMain(linked);
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'write',
    path: 'after-delete.txt',
    content: 'unrelated edit after delete',
  }]);
  await gotoMain(owner);
  await expectMainFileMissing(owner, relayUrl, 'delete-across-devices.txt');
  await expectMainFileContent(owner, relayUrl, 'after-delete.txt', 'unrelated edit after delete');

  await gotoMain(linked);
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'write',
    path: 'delete-across-devices.txt',
    content: 'recreated after delete',
  }]);
  await gotoMain(owner);
  await expectMainFileContent(owner, relayUrl, 'delete-across-devices.txt', 'recreated after delete');

  await mutateMainWithActionsAndPublish(owner, relayUrl, [{
    type: 'write',
    path: 'rename-source.txt',
    content: 'rename and retain source tombstone',
  }]);
  await gotoMain(linked);
  await expectMainFileContent(linked, relayUrl, 'rename-source.txt', 'rename and retain source tombstone');
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'rename',
    from: 'rename-source.txt',
    to: 'rename-target.txt',
  }, {
    type: 'write',
    path: 'after-rename.txt',
    content: 'unrelated edit after rename',
  }]);
  await gotoMain(owner);
  await expectMainFileMissing(owner, relayUrl, 'rename-source.txt');
  await expectMainFileContent(owner, relayUrl, 'rename-target.txt', 'rename and retain source tombstone');

  await mutateMainWithActionsAndPublish(owner, relayUrl, [{
    type: 'write',
    path: 'move-source.txt',
    content: 'move and retain source tombstone',
  }]);
  await gotoMain(linked);
  await expectMainFileContent(linked, relayUrl, 'move-source.txt', 'move and retain source tombstone');
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'mkdir',
    path: 'moved',
  }, {
    type: 'move',
    path: 'move-source.txt',
    directory: 'moved',
  }, {
    type: 'write',
    path: 'after-move.txt',
    content: 'unrelated edit after move',
  }]);
  await gotoMain(owner);
  await expectMainFileMissing(owner, relayUrl, 'move-source.txt');
  await expectMainFileContent(owner, relayUrl, 'moved/move-source.txt', 'move and retain source tombstone');

  // Hold the linked browser's production root subscriptions at the shared
  // baseline so the two action-layer writes are provably concurrent.
  await gotoMain(linked);
  const linkedResolverKey = await pauseProfileDriveRootUpdates(linked);
  await gotoMain(owner);
  await mutateMainWithActionsAndPublish(owner, relayUrl, [{
    type: 'write',
    path: 'concurrent-action.txt',
    content: 'owner concurrent bytes',
  }]);
  await mutateMainWithActionsAndPublish(linked, relayUrl, [{
    type: 'write',
    path: 'concurrent-action.txt',
    content: 'linked concurrent bytes',
  }]);
  await resumeProfileDriveRootUpdates(linked, linkedResolverKey);
  await gotoMain(owner);
  await expectMainContentsWithPrefix(owner, relayUrl, 'concurrent-action', [
    'linked concurrent bytes',
    'owner concurrent bytes',
  ]);
  await gotoMain(linked);
  await expect(
    linked.getByTestId('file-list').locator('a').filter({ hasText: 'concurrent-action' }),
  ).toHaveCount(2, { timeout: 60000 });
}

async function createLinkedDriveBrowsers(
  ownerPage: Page,
  browser: Browser,
  relayUrl: string,
): Promise<{ deviceContext: BrowserContext; devicePage: Page; profileId: string }> {
  await prepareDriveInstance(ownerPage, relayUrl);
  const profileId = await createAdminDriveUser(ownerPage);
  await expectOwnerSettingsReady(ownerPage);
  await gotoMain(ownerPage);
  await writeMainFileAndPublish(
    ownerPage,
    relayUrl,
    'before-device-link.txt',
    'present before approval',
  );
  // Reproduce an owner opening Settings in a cold session: approval must first
  // resolve the relay-published logical root instead of treating a missing
  // in-memory/local cache record as an empty Drive.
  await discardHydratedMainRootBeforeSettingsApproval(ownerPage, profileId);

  const deviceContext = await browser.newContext();
  const devicePage = await deviceContext.newPage();
  try {
    await prepareDriveInstance(devicePage, relayUrl);
    const approvalUrl = await createDeviceApprovalRequest(devicePage);
    await approveDeviceApprovalRequest(ownerPage, approvalUrl);
    await activateApprovedDevice(devicePage, profileId);
    await gotoMain(devicePage);
    await expectMainFileContent(
      devicePage,
      relayUrl,
      'before-device-link.txt',
      'present before approval',
    );
    expect(await devicePage.evaluate(async () => {
      const { getTree } = await import('/src/store.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const root = getCurrentRootCid();
      return root ? (await getTree().listDirectory(root)).map((entry) => entry.name) : [];
    })).not.toContain('.hashtree');

    await devicePage.reload({ waitUntil: 'domcontentloaded' });
    await gotoMain(devicePage);
    await expectMainFileContent(
      devicePage,
      relayUrl,
      'before-device-link.txt',
      'present before approval',
    );
    return { deviceContext, devicePage, profileId };
  } catch (error) {
    await deviceContext.close();
    throw error;
  }
}

test.describe('Drive user settings link device', () => {
  test('links an existing Drive user through an approval QR/link from another Drive instance', async ({ page, browser, relayUrl }) => {
    test.setTimeout(300000);
    const { deviceContext, devicePage } = await createLinkedDriveBrowsers(page, browser as Browser, relayUrl);
    try {
      await expectLinkedBrowsersCanExchangeEdits(page, devicePage, relayUrl);
    } finally {
      await deviceContext.close();
    }
  });

  test('activates a pasted approval link when the joining browser already has a Drive account', async ({ page, browser, relayUrl }) => {
    test.setTimeout(120000);
    await prepareDriveInstance(page, relayUrl);
    const profileId = await createAdminDriveUser(page);
    await expectOwnerSettingsReady(page);

    const deviceContext = await (browser as Browser).newContext();
    const devicePage = await deviceContext.newPage();
    try {
      await prepareDriveInstance(devicePage, relayUrl);
      await createAdminDriveUser(devicePage);
      const approvalUrl = await createDeviceApprovalRequest(devicePage);

      await devicePage.reload({ waitUntil: 'domcontentloaded' });
      await expect(devicePage.getByTestId('device-approval-request-section')).toBeVisible({ timeout: 30000 });
      await expect(devicePage.getByRole('heading', { name: 'Request Link' })).toBeVisible();

      await approveDeviceApprovalRequest(page, approvalUrl);
      await activateApprovedDevice(devicePage, profileId);
    } finally {
      await deviceContext.close();
    }
  });
});
