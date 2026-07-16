import { expect, type Page } from './fixtures';
import { getPublicKey, generateSecretKey, type Event } from 'nostr-tools';
import {
  clearAllStorage,
  configureBlossomServers,
  flushPendingPublishes,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils.js';
import {
  isNavigationContextReset,
  waitForDistinctRootTimestamp,
  type BrowserDriveFipsStats,
  type BrowserTestWindow,
  type DriveMutation,
  type VmSession,
  type WebDriveDevice,
  type WebEntry,
} from './drive-vm-interop.vm';

export async function restoreViaDriveSetup(page: Page, session: VmSession): Promise<void> {
  setupPageErrorHandler(page);
  await page.goto('/');
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, session.relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60000);
  await page.evaluate((ownerNsec) => {
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:nsec', ownerNsec);
  }, session.ownerNsec);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const store = (window as BrowserTestWindow).__nostrStore;
    return store?.getState?.().pubkey?.length === 64;
  }, { timeout: 30000 });
  await useLocalRelay(page, session.relayUrl);
  await configureBlossomServers(page, session.blossomUrl);
  await waitForRelayConnected(page, 30000);
  await page.goto(`/#/${encodeURIComponent(session.ownerNpub)}/main`);
  await waitForAppReady(page, 60000);
}

export async function pushCurrentRootToBlossom(page: Page, treeName = 'main'): Promise<void> {
  await page.evaluate(async (targetTree: string) => {
    const { getTreeRootSync } = await import('/src/stores');
    const win = window as BrowserTestWindow;
    const npub = win.__nostrStore?.getState?.().npub;
    const root = npub ? getTreeRootSync(npub, targetTree) : null;
    if (!root?.hash) {
      throw new Error(`No root for ${targetTree}`);
    }
    const adapter = win.__getWorkerAdapter?.() ?? win.__workerAdapter;
    if (!adapter?.pushToBlossom) {
      throw new Error('Worker adapter has no pushToBlossom');
    }
    const result = await adapter.pushToBlossom(root.hash, root.key, targetTree);
    if (result.failed > 0) {
      throw new Error(`Blossom push failed: ${JSON.stringify(result)}`);
    }
  }, treeName);
}

export async function readWebEntry(page: Page, path: string): Promise<WebEntry> {
  return page.evaluate(async (targetPath: string) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const state = (window as BrowserTestWindow).__nostrStore?.getState?.();
    const root = state?.npub ? getTreeRootSync(state.npub, 'main') : null;
    if (!root?.hash) return null;
    const tree = getTree();
    const entry = await tree.resolvePath(root, targetPath).catch(() => null);
    if (!entry?.cid) return null;
    if (entry.type === LinkType.Dir) {
      return { kind: 'directory' };
    }
    const data = await tree.readFile(entry.cid).catch(() => null);
    return data ? { kind: 'file', content: new TextDecoder().decode(data) } : null;
  }, path);
}

export async function expectWebFile(page: Page, path: string, expectedContent: string): Promise<void> {
  await expect.poll(
    () => readWebEntry(page, path),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toEqual({ kind: 'file', content: expectedContent });
}

export async function expectWebMissing(page: Page, path: string): Promise<void> {
  await expect.poll(
    () => readWebEntry(page, path),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toBeNull();
}

export async function expectWebEntryKind(page: Page, path: string, kind: string): Promise<void> {
  await expect.poll(
    () => readWebEntry(page, path),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toEqual({ kind });
}

export async function readWebFiles(page: Page, paths: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(async (targetPaths: string[]) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const state = (window as BrowserTestWindow).__nostrStore?.getState?.();
    const root = state?.npub ? getTreeRootSync(state.npub, 'main') : null;
    const out: Record<string, string | null> = {};
    if (!root?.hash) {
      for (const path of targetPaths) out[path] = null;
      return out;
    }
    const tree = getTree();
    for (const path of targetPaths) {
      const entry = await tree.resolvePath(root, path).catch(() => null);
      if (!entry?.cid || entry.type === LinkType.Dir) {
        out[path] = null;
        continue;
      }
      const data = await tree.readFile(entry.cid).catch(() => null);
      out[path] = data ? new TextDecoder().decode(data) : null;
    }
    return out;
  }, paths);
}

export async function expectWebFiles(page: Page, files: Record<string, string>): Promise<void> {
  await expect.poll(
    () => readWebFiles(page, Object.keys(files)),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toEqual(files);
}

export async function mutateWebTree(
  page: Page,
  mutation: DriveMutation,
  options: { recordTombstones?: boolean } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.evaluate(async ({ op, recordTombstones }) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { autosaveIfOwn } = await import('/src/nostr.ts');
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const state = (window as BrowserTestWindow).__nostrStore?.getState?.();
    const root = state?.npub ? getTreeRootSync(state.npub, 'main') : null;
    if (!root?.hash) throw new Error('missing main drive root');
    if (!state.selectedTree || state.selectedTree.name !== 'main' || state.selectedTree.pubkey !== state.pubkey) {
      throw new Error('main drive is not selected as the owned tree');
    }

    const tree = getTree();
    const splitPath = (value: string) => value.split('/').filter(Boolean);
    type RootCid = NonNullable<typeof root>;
    type DirectoryEntry = Awaited<ReturnType<typeof tree.listDirectory>>[number];

    const resolveEntry = async (rootCid: RootCid, targetParts: string[]): Promise<DirectoryEntry | null> => {
      const name = targetParts.at(-1);
      if (!name) return null;
      const parentParts = targetParts.slice(0, -1);
      const parent = parentParts.length > 0
        ? await tree.resolvePath(rootCid, parentParts.join('/')).catch(() => null)
        : { cid: rootCid, type: LinkType.Dir };
      if (!parent?.cid || parent.type !== LinkType.Dir) return null;
      const entries = await tree.listDirectory(parent.cid).catch(() => []);
      return entries.find((entry) => entry.name === name) ?? null;
    };

    const ensureParents = async (rootCid: RootCid, parentParts: string[]): Promise<RootCid> => {
      let currentRoot = rootCid;
      for (let index = 0; index < parentParts.length; index++) {
        const currentPath = parentParts.slice(0, index + 1);
        const parentPath = parentParts.slice(0, index);
        const name = parentParts[index];
        const existing = await tree.resolvePath(currentRoot, currentPath.join('/')).catch(() => null);
        if (existing?.cid && existing.type === LinkType.Dir) continue;
        if (existing?.cid) {
          currentRoot = await tree.removeEntry(currentRoot, parentPath, name);
        }
        const { cid: emptyDir } = await tree.putDirectory([]);
        currentRoot = await tree.setEntry(currentRoot, parentPath, name, emptyDir, 0, LinkType.Dir);
      }
      return currentRoot;
    };

    const visibleFilePathsUnder = async (rootCid: RootCid, targetParts: string[]): Promise<string[]> => {
      const entry = await resolveEntry(rootCid, targetParts);
      if (!entry?.cid || targetParts[0] === '.hashtree') return [];
      const path = targetParts.join('/');
      if (entry.type !== LinkType.Dir) return [path];

      const files: string[] = [];
      const collect = async (cid: RootCid, parts: string[]) => {
        const entries = await tree.listDirectory(cid).catch(() => []);
        for (const child of entries) {
          if (parts.length === 0 && child.name === '.hashtree') continue;
          const childParts = [...parts, child.name];
          if (child.type === LinkType.Dir) {
            await collect(child.cid, childParts);
          } else {
            files.push(childParts.join('/'));
          }
        }
      };
      await collect(entry.cid, targetParts);
      return files;
    };

    const writeFileAtPath = async (rootCid: RootCid, targetPath: string, content: string): Promise<RootCid> => {
      const parts = splitPath(targetPath);
      const name = parts.pop();
      if (!name) throw new Error('write path is empty');
      let currentRoot = await ensureParents(rootCid, parts);
      const existing = await resolveEntry(currentRoot, [...parts, name]);
      if (existing?.cid && existing.type === LinkType.Dir) {
        currentRoot = await tree.removeEntry(currentRoot, parts, name);
      }
      const data = new TextEncoder().encode(content);
      const { cid: fileCid, size } = await tree.putFile(data);
      return tree.setEntry(currentRoot, parts, name, fileCid, size, LinkType.Blob);
    };

    const removePathIfPresent = async (rootCid: RootCid, targetPath: string): Promise<RootCid> => {
      const parts = splitPath(targetPath);
      const name = parts.pop();
      if (!name) return rootCid;
      const existing = await resolveEntry(rootCid, [...parts, name]);
      return existing?.cid ? tree.removeEntry(rootCid, parts, name) : rootCid;
    };

    const layerTombstones = async (rootCid: RootCid, deletedPaths: string[]): Promise<RootCid> => {
      if (!recordTombstones) return rootCid;
      let currentRoot = rootCid;
      const timestamp = String(Math.floor(Date.now() / 1000));
      for (const deletedPath of Array.from(new Set(deletedPaths)).sort()) {
        currentRoot = await writeFileAtPath(currentRoot, `.hashtree/tombstones/${deletedPath}`, timestamp);
      }
      return currentRoot;
    };

    const clearTombstones = async (rootCid: RootCid, visiblePaths: string[]): Promise<RootCid> => {
      if (!recordTombstones) return rootCid;
      let currentRoot = rootCid;
      for (const visiblePath of Array.from(new Set(visiblePaths)).sort()) {
        currentRoot = await removePathIfPresent(currentRoot, `.hashtree/tombstones/${visiblePath}`);
      }
      return currentRoot;
    };

    let nextRoot = root;
    if (op.type === 'write') {
      const parts = splitPath(op.path);
      const name = parts.pop();
      if (!name) throw new Error('write path is empty');
      const existing = await resolveEntry(nextRoot, [...parts, name]);
      const deletedPaths = existing?.type === LinkType.Dir
        ? await visibleFilePathsUnder(nextRoot, [...parts, name])
        : [];
      nextRoot = await ensureParents(nextRoot, parts);
      if (existing?.type === LinkType.Dir) {
        nextRoot = await tree.removeEntry(nextRoot, parts, name);
      }
      const data = new TextEncoder().encode(op.content);
      const { cid: fileCid, size } = await tree.putFile(data);
      nextRoot = await tree.setEntry(nextRoot, parts, name, fileCid, size, LinkType.Blob);
      nextRoot = await clearTombstones(nextRoot, [op.path]);
      nextRoot = await layerTombstones(nextRoot, deletedPaths);
    } else if (op.type === 'mkdir') {
      const parts = splitPath(op.path);
      const name = parts.pop();
      if (!name) throw new Error('mkdir path is empty');
      const deletedPaths = await visibleFilePathsUnder(nextRoot, [...parts, name]);
      nextRoot = await ensureParents(nextRoot, parts);
      const existing = await tree.resolvePath(nextRoot, [...parts, name].join('/')).catch(() => null);
      if (existing?.cid) {
        nextRoot = await tree.removeEntry(nextRoot, parts, name);
      }
      const { cid: emptyDir } = await tree.putDirectory([]);
      nextRoot = await tree.setEntry(nextRoot, parts, name, emptyDir, 0, LinkType.Dir);
      nextRoot = await clearTombstones(nextRoot, [op.path]);
      nextRoot = await layerTombstones(nextRoot, deletedPaths);
    } else if (op.type === 'delete') {
      const parts = splitPath(op.path);
      const name = parts.pop();
      if (!name) throw new Error('delete path is empty');
      const deletedPaths = await visibleFilePathsUnder(nextRoot, [...parts, name]);
      nextRoot = await tree.removeEntry(nextRoot, parts, name);
      nextRoot = await layerTombstones(nextRoot, deletedPaths);
    } else {
      const fromParts = splitPath(op.from);
      const toParts = splitPath(op.to);
      const fromName = fromParts.pop();
      const toName = toParts.pop();
      if (!fromName || !toName) throw new Error('rename path is empty');
      const sourcePath = [...fromParts, fromName];
      const targetPath = [...toParts, toName];
      const sourceEntry = await resolveEntry(nextRoot, sourcePath);
      if (!sourceEntry?.cid) throw new Error(`rename source missing: ${op.from}`);
      const sourceDeletedPaths = await visibleFilePathsUnder(nextRoot, sourcePath);
      const renamedPaths = sourceDeletedPaths.map((path) => (
        path === op.from ? op.to : `${op.to}/${path.slice(op.from.length + 1)}`
      ));
      const renamedPathSet = new Set(renamedPaths);
      const targetDeletedPaths = (await visibleFilePathsUnder(nextRoot, targetPath))
        .filter((path) => !renamedPathSet.has(path));
      const deletedPaths = [...sourceDeletedPaths, ...targetDeletedPaths];
      const targetEntry = await resolveEntry(nextRoot, targetPath);
      if (targetEntry?.cid) {
        nextRoot = await tree.removeEntry(nextRoot, toParts, toName);
      }
      nextRoot = await tree.removeEntry(nextRoot, fromParts, fromName);
      nextRoot = await ensureParents(nextRoot, toParts);
      nextRoot = await tree.setEntry(
        nextRoot,
        toParts,
        toName,
        sourceEntry.cid,
        sourceEntry.size,
        sourceEntry.type,
        sourceEntry.meta,
      );
      nextRoot = await clearTombstones(nextRoot, renamedPaths);
      nextRoot = await layerTombstones(nextRoot, deletedPaths);
    }

    autosaveIfOwn(nextRoot);
      }, { op: mutation, recordTombstones: options.recordTombstones ?? true });
      return;
    } catch (error) {
      if (attempt === 0 && isNavigationContextReset(error)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
        await waitForAppReady(page, 60000);
        continue;
      }
      throw error;
    }
  }
}

export async function publishWebRootForNative(
  page: Page,
  session: VmSession,
  webDevice: WebDriveDevice,
): Promise<void> {
  webDevice.seq += 1;
  await waitForDistinctRootTimestamp();
  await flushPendingPublishes(page);
  await pushCurrentRootToBlossom(page, 'main');
  await page.evaluate(async ({ nativeDevicePubkey, webSecret, deviceSeq }) => {
    const { buildDriveRootEvent } = await import('/src/drive/protocol.ts');
    const { getTreeRootSync } = await import('/src/stores/index.ts');
    const win = window as BrowserTestWindow;
    const state = win.__nostrStore?.getState?.();
    const root = state?.npub ? getTreeRootSync(state.npub, 'main') : null;
    if (!root?.hash || !root.key) {
      throw new Error('missing encrypted main drive root');
    }
    const deviceSecretKey = new Uint8Array(webSecret);
    const rawEvent = buildDriveRootEvent({
      deviceSecretKey,
      ownerPubkeyHex: state.pubkey,
      driveId: 'main',
      root,
      dckGeneration: 1,
      deviceSeq,
      authorizedDevicePubkeys: [nativeDevicePubkey],
    });
    const adapter = win.__getWorkerAdapter?.() ?? win.__workerAdapter;
    if (!adapter?.publish) {
      throw new Error('worker adapter has no publish method');
    }
    await adapter.publish(rawEvent as Event);
  }, {
    nativeDevicePubkey: session.devicePubkey,
    webSecret: Array.from(webDevice.secret),
    deviceSeq: webDevice.seq,
  });
}

export async function authorizeWebDriveDevice(
  page: Page,
  session: VmSession,
  webDevice: WebDriveDevice,
): Promise<void> {
  await waitForDistinctRootTimestamp();
  await page.evaluate(async ({ nativeDevicePubkey, webDevicePubkey }) => {
    const { buildAppKeysEvent, wrapDriveContentKeyForAppKeys } = await import('/src/drive/protocol.ts');
    const { getSecretKey } = await import('/src/nostr/auth.ts');
    const win = window as BrowserTestWindow;
    const state = win.__nostrStore?.getState?.();
    const ownerSecret = getSecretKey();
    if (!state?.pubkey || !ownerSecret) {
      throw new Error('owner secret unavailable for AppKeys publish');
    }
    const now = Math.floor(Date.now() / 1000);
    const dckPlaintext = '0123456789abcdef0123456789abcdef';
    const event = buildAppKeysEvent({
      owner_pubkey: state.pubkey,
      created_at: now,
      app_keys: [
        { pubkey: nativeDevicePubkey, added_at: now - 1, label: 'iris-drive-vm' },
        { pubkey: webDevicePubkey, added_at: now, label: 'iris-files-web' },
      ],
      dck_generation: 1,
      wrapped_dck: wrapDriveContentKeyForAppKeys(ownerSecret, dckPlaintext, [nativeDevicePubkey, webDevicePubkey]),
    }, ownerSecret);
    const adapter = win.__getWorkerAdapter?.() ?? win.__workerAdapter;
    if (!adapter?.publish) {
      throw new Error('worker adapter has no publish method');
    }
    await adapter.publish(event as Event);
  }, {
    nativeDevicePubkey: session.devicePubkey,
    webDevicePubkey: webDevice.pubkey,
  });
}

export async function webWriteAndPublish(page: Page, session: VmSession, device: WebDriveDevice, path: string, content: string): Promise<void> {
  await mutateWebTree(page, { type: 'write', path, content });
  await publishWebRootForNative(page, session, device);
}

export async function webMkdirAndPublish(page: Page, session: VmSession, device: WebDriveDevice, path: string): Promise<void> {
  await mutateWebTree(page, { type: 'mkdir', path });
  await publishWebRootForNative(page, session, device);
}

export async function webDeleteAndPublish(page: Page, session: VmSession, device: WebDriveDevice, path: string): Promise<void> {
  await mutateWebTree(page, { type: 'delete', path });
  await publishWebRootForNative(page, session, device);
}

export async function webRenameAndPublish(page: Page, session: VmSession, device: WebDriveDevice, from: string, to: string): Promise<void> {
  await mutateWebTree(page, { type: 'rename', from, to });
  await publishWebRootForNative(page, session, device);
}

export function newWebDriveDevice(): WebDriveDevice {
  const secret = generateSecretKey();
  return {
    secret,
    pubkey: getPublicKey(secret),
    seq: 0,
  };
}

export async function startBrowserDriveFips(
  page: Page,
  session: VmSession,
  webDevice: WebDriveDevice,
): Promise<BrowserDriveFipsStats> {
  return page.evaluate(async ({ relayUrl, webSecret }) => {
    const { startDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const runtime = await startDriveFipsRuntime({
      deviceSecretKey: new Uint8Array(webSecret),
      relays: [relayUrl],
      storeName: `iris-drive-fips-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      connectTimeoutMs: 20_000,
      relayConnectTimeoutMs: 5_000,
      iceGatherTimeoutMs: 6_000,
      requestTimeoutMs: 8_000,
      log: true,
    });
    const win = window as BrowserTestWindow;
    win.__irisDriveFips = runtime;
    return runtime.getStats();
  }, {
    relayUrl: session.relayUrl,
    webSecret: Array.from(webDevice.secret),
  });
}

export async function stopBrowserDriveFips(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const win = window as BrowserTestWindow;
    win.__workerAdapter?.setP2PProvider?.(null);
    await win.__irisDriveFips?.stop();
    delete win.__irisDriveFips;
  }).catch(() => undefined);
}

export async function browserDriveFipsStats(page: Page): Promise<BrowserDriveFipsStats | null> {
  try {
    return await page.evaluate(() => {
      const runtime = (window as BrowserTestWindow).__irisDriveFips;
      return runtime?.getStats() ?? null;
    });
  } catch (error) {
    if (isNavigationContextReset(error)) {
      return null;
    }
    throw error;
  }
}

export async function ensureBrowserDriveFipsStats(
  page: Page,
  session: VmSession,
  webDevice: WebDriveDevice,
): Promise<BrowserDriveFipsStats | null> {
  const existing = await browserDriveFipsStats(page);
  if (existing?.active && existing.localXOnlyPubkey === webDevice.pubkey) {
    return existing;
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await waitForAppReady(page, 60000).catch(() => {});
  return startBrowserDriveFips(page, session, webDevice).catch((error) => {
    if (isNavigationContextReset(error)) {
      return null;
    }
    throw error;
  });
}
