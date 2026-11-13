// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { signNostrIdentityRosterOp } from '../src/drive/protocol';
import { subscriptionState } from '../src/stores/treeRootShared';

const shared = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  secretKey: null as Uint8Array | null,
  storeListeners: new Set<(state: { connectedRelays: number }) => void>(),
  subscribe: vi.fn((_filters: unknown, _options?: unknown) => ({ on: vi.fn(), stop: vi.fn() })),
}));

vi.mock('../src/nostr', () => ({
  getCurrentNostrIdentitySession: () => shared.session,
  getSecretKey: () => shared.secretKey,
  nostr: { fetchEvents: vi.fn(async () => new Set()), subscribe: shared.subscribe },
  useNostrStore: {
    getState: () => ({ connectedRelays: 1 }),
    subscribe: (listener: (state: { connectedRelays: number }) => void) => {
      shared.storeListeners.add(listener);
      return () => shared.storeListeners.delete(listener);
    },
  },
}));

vi.mock('../src/store', () => ({ getTree: () => null }));

vi.mock('../src/refResolver', () => ({
  getRefResolver: () => ({ subscribe: vi.fn(() => () => {}) }),
  getResolverKey: (npub?: string, treeName?: string) => (npub && treeName ? `${npub}/${treeName}` : null),
}));

vi.mock('../src/lib/nativeTreeRootCache', () => ({ syncNativeTreeRootCache: vi.fn(async () => {}) }));

vi.mock('../src/stores/treeRootWorker', () => ({
  WORKER_READY_TIMEOUT_MS: 1,
  clearWorkerHydrateRetry: vi.fn(),
  ensureWorkerTreeRootSubscription: vi.fn(async () => false),
  hydrateTreeRootFromWorker: vi.fn(async () => false),
  scheduleWorkerHydrateRetry: vi.fn(),
  unsubscribeWorkerTreeRootSubscription: vi.fn(async () => {}),
  waitForWorkerReady: vi.fn(async () => {}),
}));

const PROFILE_ID = '44444444-5555-4666-8777-888888888888';
const KEY = `${PROFILE_ID}/main`;

function facet(pubkey: string, admin: boolean) {
  return {
    pubkey,
    purposes: ['app_key'],
    capabilities: {
      can_write_roots: true,
      can_admin_profile: admin,
      can_receive_secret_wraps: true,
      can_decrypt_secret_epochs: true,
    },
    added_at: 100,
  };
}

/** Relay backfills of Drive roots, as the authors they ask for. */
function backfills(): string[][] {
  return shared.subscribe.mock.calls
    .filter(([, options]) => (options as { closeAfterHistory?: boolean } | undefined)?.closeAfterHistory === true)
    .map(([filters]) => (filters as Array<{ authors?: string[] }>).flatMap((filter) => filter.authors ?? []));
}

function notifyStore(): void {
  for (const listener of shared.storeListeners) listener({ connectedRelays: 1 });
}

describe('Drive root backfill after a roster change', () => {
  beforeEach(() => {
    for (const state of subscriptionState.values()) state.unsubscribeResolver?.();
    subscriptionState.clear();
    shared.subscribe.mockClear();
    shared.storeListeners.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the roots at once when a device is approved, then soon again', async () => {
    vi.useFakeTimers();
    const adminSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const bootstrap = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      clientNonce: '44444444-5555-4666-8777-888888888889',
      createdAt: 100,
      op: { op: 'add_facet', facet: facet(adminPubkey, true) },
    });
    shared.secretKey = adminSecret;
    shared.session = { profileId: PROFILE_ID, appKeyPubkey: adminPubkey, status: 'active', rosterOps: [bootstrap], createdAt: 100 };
    const { subscribeToResolver } = await import('../src/stores/treeRootResolver');

    const unsubscribe = subscribeToResolver(KEY, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(backfills()).toEqual([[adminPubkey]]);

    // Nothing changes for a while: the backfill backs off to minutes.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const quiet = backfills().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backfills().length).toBe(quiet);

    // Another device is approved: its roots are asked for at once.
    const phonePubkey = getPublicKey(generateSecretKey());
    const approve = signNostrIdentityRosterOp({
      signerSecretKey: adminSecret,
      profileId: PROFILE_ID,
      parents: [bootstrap.op_id],
      clientNonce: '44444444-5555-4666-8777-888888888890',
      createdAt: 101,
      op: { op: 'add_facet', facet: facet(phonePubkey, false) },
    });
    shared.session = { ...shared.session, rosterOps: [bootstrap, approve] };
    notifyStore();
    expect(backfills().length).toBe(quiet + 1);
    expect(backfills().at(-1)).toEqual([adminPubkey, phonePubkey].sort());

    // And again after the shortest wait, not after minutes.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(backfills().length).toBe(quiet + 2);

    // Other store changes do not ask the relays.
    notifyStore();
    expect(backfills().length).toBe(quiet + 2);
    unsubscribe();
  });
});
