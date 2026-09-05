// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HashTree,
  LinkType,
  MemoryStore,
  fromHex,
} from '@hashtree/core';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  buildDriveRootEvent,
  parseDriveRootEventForDevice,
  signNostrIdentityRosterOp,
} from '../src/drive/protocol';
import { profileDriveProjection } from '../src/drive/profileDriveProjection';
import { treeRootRegistry } from '../src/TreeRootRegistry';
import { subscriptionState } from '../src/stores/treeRootShared';

const shared = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  secretKey: null as Uint8Array | null,
  tree: null as HashTree | null,
  fetchEvents: vi.fn(async () => new Set()),
}));

vi.mock('../src/nostr', () => ({
  getCurrentNostrIdentitySession: () => shared.session,
  getSecretKey: () => shared.secretKey,
  ndk: {
    fetchEvents: shared.fetchEvents,
    subscribe: vi.fn(() => ({ on: vi.fn(), stop: vi.fn() })),
  },
  useNostrStore: {
    getState: () => ({ connectedRelays: 1 }),
    subscribe: () => () => {},
  },
}));

vi.mock('../src/store', () => ({
  getTree: () => shared.tree,
}));

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({ subscribe: vi.fn(() => () => {}) }),
  getResolverKey: (npub?: string, treeName?: string) => (
    npub && treeName ? `${npub}/${treeName}` : null
  ),
}));

vi.mock('../src/lib/nativeTreeRootCache', () => ({
  syncNativeTreeRootCache: vi.fn(async () => {}),
}));

vi.mock('../src/stores/treeRootWorker', () => ({
  WORKER_READY_TIMEOUT_MS: 1,
  clearWorkerHydrateRetry: vi.fn(),
  ensureWorkerTreeRootSubscription: vi.fn(async () => false),
  hydrateTreeRootFromWorker: vi.fn(async () => false),
  scheduleWorkerHydrateRetry: vi.fn(),
  unsubscribeWorkerTreeRootSubscription: vi.fn(async () => {}),
  waitForWorkerReady: vi.fn(async () => {}),
}));

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';
const OTHER_PROFILE_ID = '11111111-2222-4333-8444-555555555555';
const RELOADED_PROFILE_ID = '22222222-3333-4444-8555-666666666666';
const PUBLISHING_PROFILE_ID = '33333333-4444-4555-8666-777777777777';

function clearResolverState(): void {
  for (const state of subscriptionState.values()) {
    state.unsubscribeResolver?.();
    state.unsubscribeWorker?.();
  }
  subscriptionState.clear();
  profileDriveProjection.clear();
  treeRootRegistry.delete(PROFILE_ID, 'main');
  treeRootRegistry.delete(OTHER_PROFILE_ID, 'main');
  treeRootRegistry.delete(RELOADED_PROFILE_ID, 'main');
  treeRootRegistry.delete(PUBLISHING_PROFILE_ID, 'main');
}

function activateProfile(profileId = PROFILE_ID): {
  appSecret: Uint8Array;
  appPubkey: string;
  rosterOp: ReturnType<typeof signNostrIdentityRosterOp>;
} {
  const appSecret = generateSecretKey();
  const appPubkey = getPublicKey(appSecret);
  const rosterOp = signNostrIdentityRosterOp({
    signerSecretKey: appSecret,
    profileId,
    clientNonce: '89f3d04f-41fb-437b-9339-75df537bf292',
    createdAt: 100,
    op: {
      op: 'add_facet',
      facet: {
        pubkey: appPubkey,
        purposes: ['app_key'],
        capabilities: {
          can_write_roots: true,
          can_admin_profile: true,
          can_receive_secret_wraps: true,
          can_decrypt_secret_epochs: true,
        },
        added_at: 100,
      },
    },
  });
  shared.session = {
    profileId,
    appKeyPubkey: appPubkey,
    appKeyNpub: nip19.npubEncode(appPubkey),
    appKeyNsec: nip19.nsecEncode(appSecret),
    status: 'active',
    rosterOps: [rosterOp],
    createdAt: 100,
  };
  shared.secretKey = appSecret;
  return { appSecret, appPubkey, rosterOp };
}

describe('NostrIdentity tree-root scope', () => {
  beforeEach(() => {
    clearResolverState();
    shared.session = null;
    shared.secretKey = null;
    shared.tree = null;
    shared.fetchEvents.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    treeRootRegistry.setPublishFn(
      null as unknown as Parameters<typeof treeRootRegistry.setPublishFn>[0],
    );
  });

  it('does not hydrate or emit a UUID registry snapshot without the matching active session', async () => {
    const staleHash = fromHex('11'.repeat(32));
    const staleKey = fromHex('12'.repeat(32));
    treeRootRegistry.setFromExternal(PROFILE_ID, 'main', staleHash, 'prefetch', {
      key: staleKey,
      visibility: 'private',
      updatedAt: 123,
    });
    shared.session = {
      profileId: OTHER_PROFILE_ID,
      appKeyPubkey: 'aa'.repeat(32),
      status: 'active',
      rosterOps: [],
    };
    const callback = vi.fn();
    const { subscribeToResolver } = await import('../src/stores/treeRootResolver');

    const unsubscribe = subscribeToResolver(`${PROFILE_ID}/main`, callback);
    await Promise.resolve();

    expect(callback).not.toHaveBeenCalled();
    expect(treeRootRegistry.get(PROFILE_ID, 'main')).toBeNull();
    expect(shared.fetchEvents).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('rebuilds a persisted UUID root on the first authorization fingerprint after reload', async () => {
    const { appSecret, appPubkey } = activateProfile(RELOADED_PROFILE_ID);
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const authorizedFile = await tree.putFile(new TextEncoder().encode('authorized'));
    const revokedFile = await tree.putFile(new TextEncoder().encode('revoked'));
    const authorizedRoot = (await tree.putDirectory([{
      name: 'authorized.txt',
      cid: authorizedFile.cid,
      size: authorizedFile.size,
      type: LinkType.Blob,
    }])).cid;
    const persistedRoot = (await tree.putDirectory([{
      name: 'revoked.txt',
      cid: revokedFile.cid,
      size: revokedFile.size,
      type: LinkType.Blob,
    }])).cid;
    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: RELOADED_PROFILE_ID,
      driveId: 'main',
      root: authorizedRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    profileDriveProjection.add(event, parseDriveRootEventForDevice(event, appSecret));
    treeRootRegistry.setFromExternal(
      RELOADED_PROFILE_ID,
      'main',
      persistedRoot.hash,
      'prefetch',
      {
        key: persistedRoot.key,
        visibility: 'private',
        updatedAt: 999,
      },
    );
    const { refreshDriveRootResolverKey } = await import('../src/stores/treeRootResolver');

    refreshDriveRootResolverKey(`${RELOADED_PROFILE_ID}/main`);

    await vi.waitFor(() => {
      expect(treeRootRegistry.get(RELOADED_PROFILE_ID, 'main')?.updatedAt).toBe(100);
    });
    const current = treeRootRegistry.get(RELOADED_PROFILE_ID, 'main')!;
    expect((await tree.listDirectory({ hash: current.hash, key: current.key }))
      .map((entry) => entry.name)).toEqual(['authorized.txt']);
  });

  it('forces an awaitable author-scoped rebuild instead of trusting a stale registry record', async () => {
    const { appSecret, appPubkey } = activateProfile();

    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const file = await tree.putFile(new TextEncoder().encode('current'));
    const sourceRoot = (await tree.putDirectory([{
      name: 'current.txt',
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    }])).cid;
    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: sourceRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    profileDriveProjection.add(event, parseDriveRootEventForDevice(event, appSecret));
    treeRootRegistry.setFromExternal(
      PROFILE_ID,
      'main',
      fromHex('22'.repeat(32)),
      'prefetch',
      {
        key: fromHex('23'.repeat(32)),
        visibility: 'private',
        updatedAt: 999,
      },
    );
    const { resolveDriveRootProjectionNow } = await import('../src/stores/treeRootResolver');

    await expect(resolveDriveRootProjectionNow(`${PROFILE_ID}/main`)).resolves.toBe(true);

    expect(shared.fetchEvents).toHaveBeenCalledWith([{
      kinds: [30078],
      authors: [appPubkey],
      '#d': [`iris-drive/${PROFILE_ID}/main/root`],
      limit: 1,
    }]);
    const current = treeRootRegistry.get(PROFILE_ID, 'main');
    expect(current).not.toBeNull();
    expect(current!.updatedAt).toBe(100);
    const entries = await tree.listDirectory({ hash: current!.hash, key: current!.key });
    expect(entries.map((entry) => entry.name)).toEqual(['current.txt']);
  });

  it('rebuilds a locally retained root even when its relay echo is deduplicated', async () => {
    const { appSecret, appPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const file = await tree.putFile(new TextEncoder().encode('local retained event'));
    const sourceRoot = (await tree.putDirectory([{
      name: 'local.txt',
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    }])).cid;
    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: sourceRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    expect(profileDriveProjection.add(
      event,
      parseDriveRootEventForDevice(event, appSecret),
    )).toBe(true);
    const { rebuildRetainedDriveRootProjection } = await import('../src/stores/treeRootResolver');

    expect(rebuildRetainedDriveRootProjection(`${PROFILE_ID}/main`)).toBe(true);
    // This is the exact relay-echo path after the publisher retained the event.
    expect(profileDriveProjection.add(
      event,
      parseDriveRootEventForDevice(event, appSecret),
    )).toBe(false);

    await vi.waitFor(() => {
      expect(treeRootRegistry.get(PROFILE_ID, 'main')).not.toBeNull();
    });
    const current = treeRootRegistry.get(PROFILE_ID, 'main')!;
    expect((await tree.listDirectory({ hash: current.hash, key: current.key }))
      .map((entry) => entry.name)).toEqual(['local.txt']);
  });

  it('refuses to discard a newer dirty local root when its publish cannot be flushed', async () => {
    activateProfile();
    const localHash = fromHex('31'.repeat(32));
    const localKey = fromHex('32'.repeat(32));
    treeRootRegistry.setLocal(PROFILE_ID, 'main', localHash, {
      key: localKey,
      visibility: 'private',
    });
    const { resolveDriveRootProjectionNow } = await import('../src/stores/treeRootResolver');

    await expect(resolveDriveRootProjectionNow(`${PROFILE_ID}/main`, {
      publishWaitTimeoutMs: 0,
    }))
      .rejects.toThrow('Could not publish the newest local Drive root');

    const retained = treeRootRegistry.get(PROFILE_ID, 'main');
    expect(retained?.dirty).toBe(true);
    expect(retained?.hash).toEqual(localHash);
    expect(shared.fetchEvents).not.toHaveBeenCalled();
  });

  it('waits for an already in-flight local root publish before rebuilding', async () => {
    vi.useFakeTimers();
    const { appSecret, appPubkey } = activateProfile(PUBLISHING_PROFILE_ID);
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const file = await tree.putFile(new TextEncoder().encode('in flight'));
    const sourceRoot = (await tree.putDirectory([{
      name: 'current.txt',
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    }])).cid;
    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: PUBLISHING_PROFILE_ID,
      driveId: 'main',
      root: sourceRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    profileDriveProjection.add(event, parseDriveRootEventForDevice(event, appSecret));

    let publishStarted!: () => void;
    const started = new Promise<void>((resolve) => { publishStarted = resolve; });
    let finishPublish!: () => void;
    const finishing = new Promise<void>((resolve) => { finishPublish = resolve; });
    const publish = vi.fn(async () => {
      publishStarted();
      await finishing;
      return true;
    });
    treeRootRegistry.setPublishFn(publish);
    treeRootRegistry.setLocal(PUBLISHING_PROFILE_ID, 'main', sourceRoot.hash, {
      key: sourceRoot.key,
      visibility: 'private',
    });

    // Let the registry throttle fire and remove its timer while the async
    // publish remains unresolved. A flush alone cannot observe this promise.
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    const { resolveDriveRootProjectionNow } = await import('../src/stores/treeRootResolver');
    const resolving = resolveDriveRootProjectionNow(`${PUBLISHING_PROFILE_ID}/main`, {
      publishWaitTimeoutMs: 1_000,
      publishWaitPollIntervalMs: 10,
    });
    await Promise.resolve();

    finishPublish();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(resolving).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    const current = treeRootRegistry.get(PUBLISHING_PROFILE_ID, 'main')!;
    expect(current.dirty).toBe(false);
    expect((await tree.listDirectory({ hash: current.hash, key: current.key }))
      .map((entry) => entry.name)).toEqual(['current.txt']);
  });

  it('retries a retained root on a later backfill after materialization fails', async () => {
    const { appSecret, appPubkey } = activateProfile();
    const tree = new HashTree({ store: new MemoryStore() });
    const file = await tree.putFile(new TextEncoder().encode('eventually'));
    const sourceRoot = (await tree.putDirectory([{
      name: 'eventually.txt',
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    }])).cid;
    const event = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: sourceRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    profileDriveProjection.add(event, parseDriveRootEventForDevice(event, appSecret));
    shared.tree = {
      listDirectory: vi.fn(async () => {
        throw new Error('blocks unavailable');
      }),
    } as unknown as HashTree;
    const {
      refreshDriveRootResolverKey,
      resolveDriveRootProjectionNow,
    } = await import('../src/stores/treeRootResolver');

    await expect(resolveDriveRootProjectionNow(`${PROFILE_ID}/main`))
      .rejects.toThrow('blocks unavailable');
    expect(profileDriveProjection.hasAuthorizedRoots(
      PROFILE_ID,
      'main',
      new Set([appPubkey]),
    )).toBe(true);

    shared.tree = tree;
    refreshDriveRootResolverKey(`${PROFILE_ID}/main`);
    await vi.waitFor(() => {
      expect(treeRootRegistry.get(PROFILE_ID, 'main')).not.toBeNull();
    });
    const recovered = treeRootRegistry.get(PROFILE_ID, 'main')!;
    expect((await tree.listDirectory({ hash: recovered.hash, key: recovered.key }))
      .map((entry) => entry.name)).toEqual(['eventually.txt']);
  });

  it('rebuilds immediately and evicts a revoked AppKey contribution after a roster change', async () => {
    const { appSecret, appPubkey, rosterOp: bootstrap } = activateProfile();
    const revokedSecret = generateSecretKey();
    const revokedPubkey = getPublicKey(revokedSecret);
    const addRevoked = signNostrIdentityRosterOp({
      signerSecretKey: appSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      clientNonce: '89f3d04f-41fb-437b-9339-75df537bf293',
      createdAt: 101,
      op: {
        op: 'add_facet',
        facet: {
          pubkey: revokedPubkey,
          purposes: ['app_key'],
          capabilities: { can_write_roots: true },
          added_at: 101,
        },
      },
    });
    shared.session = { ...shared.session, rosterOps: [bootstrap, addRevoked] };
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const adminFile = await tree.putFile(new TextEncoder().encode('admin'));
    const revokedFile = await tree.putFile(new TextEncoder().encode('revoked'));
    const adminRoot = (await tree.putDirectory([{
      name: 'admin.txt',
      cid: adminFile.cid,
      size: adminFile.size,
      type: LinkType.Blob,
    }])).cid;
    const revokedRoot = (await tree.putDirectory([{
      name: 'revoked.txt',
      cid: revokedFile.cid,
      size: revokedFile.size,
      type: LinkType.Blob,
    }])).cid;
    const adminEvent = buildDriveRootEvent({
      deviceSecretKey: appSecret,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: adminRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 100,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    const revokedEvent = buildDriveRootEvent({
      deviceSecretKey: revokedSecret,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: revokedRoot,
      dckGeneration: 1,
      appKeySeq: 1,
      publishedAt: 101,
      authorizedAppKeyPubkeys: [appPubkey],
    });
    profileDriveProjection.add(adminEvent, parseDriveRootEventForDevice(adminEvent, appSecret));
    profileDriveProjection.add(revokedEvent, parseDriveRootEventForDevice(revokedEvent, appSecret));
    const {
      refreshDriveRootResolverKey,
      resolveDriveRootProjectionNow,
    } = await import('../src/stores/treeRootResolver');
    await resolveDriveRootProjectionNow(`${PROFILE_ID}/main`);
    let current = treeRootRegistry.get(PROFILE_ID, 'main')!;
    expect((await tree.listDirectory({ hash: current.hash, key: current.key }))
      .map((entry) => entry.name)).toEqual(['admin.txt', 'revoked.txt']);

    const revoke = signNostrIdentityRosterOp({
      signerSecretKey: appSecret,
      profileId: PROFILE_ID,
      parents: [addRevoked.op_id],
      clientNonce: '89f3d04f-41fb-437b-9339-75df537bf294',
      createdAt: 102,
      op: { op: 'tombstone_facet', pubkey: revokedPubkey },
    });
    shared.session = { ...shared.session, rosterOps: [bootstrap, addRevoked, revoke] };
    refreshDriveRootResolverKey(`${PROFILE_ID}/main`);
    await vi.waitFor(() => {
      expect(treeRootRegistry.get(PROFILE_ID, 'main')).not.toBeNull();
    });
    current = treeRootRegistry.get(PROFILE_ID, 'main')!;
    expect((await tree.listDirectory({ hash: current.hash, key: current.key }))
      .map((entry) => entry.name)).toEqual(['admin.txt']);
    expect(profileDriveProjection.hasAuthorizedRoots(
      PROFILE_ID,
      'main',
      new Set([revokedPubkey]),
    )).toBe(false);
  });
});
