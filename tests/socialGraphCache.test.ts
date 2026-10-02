import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialGraph } from 'nostr-social-graph';
import { finalizeEvent, getPublicKey } from 'nostr-tools';

const state = vi.hoisted(() => ({
  adapter: null as ReturnType<typeof makeAdapter> | null,
  pubkey: null as string | null,
}));

vi.mock('../src/workerAdapter', () => ({ getWorkerAdapter: () => state.adapter }));
vi.mock('../src/nostr/store', () => ({
  nostrStore: { getState: () => ({ pubkey: state.pubkey }) },
}));

const secret = new Uint8Array(32);
secret[31] = 1;
const ROOT = getPublicKey(secret);
const TARGET = '22'.repeat(32);
const FRIEND = '33'.repeat(32);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function makeAdapter() {
  const graph = new SocialGraph(ROOT);
  let notify = (_version: number) => {};
  return {
    graph,
    notify: (version: number) => notify(version),
    onSocialGraphVersion: vi.fn((callback: (version: number) => void) => { notify = callback; }),
    getFollowers: vi.fn(async (pubkey: string) => [...graph.getFollowersByUser(pubkey)]),
    getFollowedByFriends: vi.fn(async (_pubkey: string): Promise<string[]> => []),
    getFollowDistance: vi.fn(async (pubkey: string) => graph.getFollowDistance(pubkey)),
    isFollowing: vi.fn(async (follower: string, followed: string) => graph.isFollowing(follower, followed)),
    getFollows: vi.fn(async (pubkey: string) => [...graph.getFollowedByUser(pubkey)]),
    getSocialGraphSize: vi.fn(async () => graph.size()),
    fetchUserFollows: vi.fn(async (_pubkey: string) => {}),
    fetchUserFollowers: vi.fn(async (_pubkey: string) => {}),
  };
}

type GraphModule = typeof import('../src/utils/socialGraph');
let api: GraphModule;
let adapter: ReturnType<typeof makeAdapter>;

async function settle() {
  await vi.advanceTimersByTimeAsync(100);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  state.pubkey = ROOT;
  state.adapter = adapter = makeAdapter();
  api = await import('../src/utils/socialGraph');
  api.setupVersionCallback();
  adapter.notify(1);
  api.fetchUserFollowers(TARGET);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('worker social graph cache coherence', () => {
  it('refreshes a signed contact update after UI notifications outpace worker revisions', async () => {
    // These are real cache completions, not worker graph revisions.
    api.getFollowDistance(ROOT);
    await settle();
    api.getFollows(ROOT);
    await settle();
    expect(api.socialGraphStore.getState().version).toBeGreaterThan(2);
    expect(api.getFollowers(TARGET)).toEqual(new Set());
    await settle();

    const contact = finalizeEvent({
      kind: 3, content: '', tags: [['p', TARGET]], created_at: Math.floor(Date.now() / 1000),
    }, secret);
    // The adapter boundary follows the worker's real graph-update/notify order.
    expect(adapter.graph.handleEvent(contact, true)).toBe(true);
    expect(adapter.graph.getFollowersByUser(TARGET)).toEqual(new Set([ROOT]));
    adapter.notify(2);
    api.getFollowers(TARGET);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT]));
  });

  it('keeps a late friends-only response separate from all known followers', async () => {
    const all = deferred<string[]>();
    const friends = deferred<string[]>();
    adapter.getFollowers.mockReturnValueOnce(all.promise);
    adapter.getFollowedByFriends.mockReturnValueOnce(friends.promise);
    api.getFollowers(TARGET);
    api.getFollowedByFriends(TARGET);
    all.resolve([ROOT, FRIEND]);
    await settle();
    friends.resolve([FRIEND]);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT, FRIEND]));
    expect(api.getFollowedByFriends(TARGET)).toEqual(new Set([FRIEND]));
  });

  it('notifies subscribers when follower membership changes at the same count', async () => {
    adapter.getFollowers.mockResolvedValue([ROOT]);
    api.getFollowers(TARGET);
    await settle();
    const changed = deferred<string[]>();
    adapter.getFollowers.mockReturnValueOnce(changed.promise);
    adapter.notify(20);
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT]));
    const versionBeforeResult = api.socialGraphStore.getState().version;
    changed.resolve([FRIEND]);
    await settle();
    expect(api.socialGraphStore.getState().version).toBeGreaterThan(versionBeforeResult);
    expect(api.getFollowers(TARGET)).toEqual(new Set([FRIEND]));
  });

  it('does not let an old graph response overwrite a newer graph response', async () => {
    const old = deferred<string[]>();
    const fresh = deferred<string[]>();
    adapter.getFollowers.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    api.getFollowers(TARGET);
    adapter.notify(2);
    api.getFollowers(TARGET);
    expect(adapter.getFollowers).toHaveBeenCalledTimes(2);
    fresh.resolve([FRIEND]);
    await settle();
    old.resolve([ROOT]);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set([FRIEND]));
  });

  it('ignores old adapter callbacks and replies without clearing a replacement request', async () => {
    const old = deferred<string[]>();
    adapter.getFollowers.mockReturnValueOnce(old.promise);
    api.getFollowers(TARGET);
    const replacement = makeAdapter();
    const fresh = deferred<string[]>();
    replacement.getFollowers.mockReturnValueOnce(fresh.promise);
    state.adapter = replacement;
    api.setupVersionCallback();
    api.getFollowers(TARGET);
    const version = api.socialGraphStore.getState().version;
    adapter.notify(999);
    expect(api.socialGraphStore.getState().version).toBe(version);
    old.resolve([ROOT]);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set());
    expect(replacement.getFollowers).toHaveBeenCalledTimes(1);
    fresh.resolve([FRIEND]);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set([FRIEND]));
  });

  it('drops cached values and outstanding results after the account changes', async () => {
    adapter.getFollowDistance.mockResolvedValue(1);
    api.getFollowDistance(TARGET);
    await settle();
    expect(api.getFollowDistance(TARGET)).toBe(1);
    const old = deferred<string[]>();
    adapter.getFollowers.mockReturnValueOnce(old.promise);
    api.getFollowers(TARGET);
    state.pubkey = FRIEND;
    adapter.getFollowDistance.mockResolvedValue(1000);
    expect(api.getFollowDistance(TARGET)).toBe(1000);
    old.resolve([ROOT]);
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set());
    expect(api.getFollowDistance(TARGET)).toBe(1000);
  });

  it('does not requery on UI notifications or notify for reordered identical members', async () => {
    adapter.getFollowers.mockResolvedValue([ROOT, FRIEND]);
    api.getFollowers(TARGET);
    api.getFollowers(TARGET);
    expect(adapter.getFollowers).toHaveBeenCalledTimes(1);
    await settle();
    api.socialGraphStore.incrementVersion();
    await settle();
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT, FRIEND]));
    expect(adapter.getFollowers).toHaveBeenCalledTimes(1);

    adapter.getFollowers.mockResolvedValue([FRIEND, ROOT]);
    adapter.notify(20);
    const version = api.socialGraphStore.getState().version;
    api.getFollowers(TARGET);
    await settle();
    expect(api.socialGraphStore.getState().version).toBe(version);
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT, FRIEND]));
  });

  it('releases a failed query so the next read can refresh', async () => {
    adapter.getFollowers.mockRejectedValueOnce(new Error('worker disconnected'));
    api.getFollowers(TARGET);
    await settle();
    adapter.getFollowers.mockResolvedValue([ROOT]);
    api.getFollowers(TARGET);
    await settle();
    api.unwatchUserFollowers(TARGET);
    expect(api.getFollowers(TARGET)).toEqual(new Set([ROOT]));
    expect(adapter.getFollowers).toHaveBeenCalledTimes(2);
  });
});
