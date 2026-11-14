import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const adapter = vi.hoisted(() => ({ current: null as null | { getFollowDistance: (pubkey: string) => Promise<number> } }));
vi.mock('../src/workerAdapter', () => ({ getWorkerAdapter: () => adapter.current }));
vi.mock('../src/utils/socialGraph', async () => {
  const { writable } = await import('svelte/store');
  const version = writable({ version: 0 });
  return { socialGraphStore: { subscribe: version.subscribe }, bump: () => version.update(state => ({ version: state.version + 1 })) };
});

const { followDistance, usableDistance } = await import('../src/lib/followDistance');
const graph = await import('../src/utils/socialGraph') as unknown as { bump: () => void };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  adapter.current = null;
});

describe('follow distance', () => {
  it('says only what the graph is sure of', () => {
    expect(usableDistance(0)).toBe(0);
    expect(usableDistance(2)).toBe(2);
    expect(usableDistance(1000)).toBeNull();
    expect(usableDistance(-1)).toBeNull();
    expect(usableDistance(undefined)).toBeNull();
  });

  it('asks the worker what it already holds, and nothing when there is no worker', async () => {
    const asked: string[] = [];
    const distances: Record<string, number> = { a: 1, b: 1000 };
    adapter.current = { getFollowDistance: async (pubkey) => { asked.push(pubkey); return distances[pubkey] ?? 1000; } };
    const followed = followDistance('a');
    const stranger = followDistance('b');
    const stop = [followed.subscribe(() => {}), stranger.subscribe(() => {})];
    await flush();
    expect(get(followed)).toBe(1);
    expect(get(stranger)).toBeNull();
    // Asked once per graph version; a change of the graph asks again.
    distances.b = 2;
    graph.bump();
    await flush();
    expect(get(stranger)).toBe(2);
    stop.forEach(unsubscribe => unsubscribe());

    adapter.current = null;
    graph.bump();
    expect(get(followDistance('c'))).toBeNull();
    expect(asked.filter(pubkey => pubkey === 'c')).toEqual([]);
  });
});
