import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const { subscribeMock, directMock, stopDirect } = vi.hoisted(() => ({
  subscribeMock: vi.fn(), directMock: vi.fn(), stopDirect: vi.fn(),
}));
const REPRESENTATIVE = 'a'.repeat(64);

vi.mock('../src/nostr/client', () => ({ nostr: { subscribe: subscribeMock } }));
vi.mock('../src/nostr/directQuery', () => ({ queryConfiguredRelaysDirectly: directMock }));
vi.mock('../src/lib/workerInit', () => ({ waitForWorkerAdapter: () => Promise.resolve(null) }));
vi.mock('../src/nostr/auth', () => ({
  getStoredNostrIdentitySessionForAccount: () => ({ profileId: 'profile', rosterOps: [] }),
}));
vi.mock('../src/drive/protocol', () => ({
  KIND_NOSTR_IDENTITY_ROSTER_OP: 0,
  parseNostrIdentityRosterOpEvent: vi.fn(),
  projectNostrIdentityRoster: () => ({ profileId: 'profile' }),
}));
vi.mock('@iris/identity', () => ({
  representativeProfileAuthors: () => [REPRESENTATIVE],
  selectLatestRepresentativeProfileEvent: (_projection: unknown, events: Array<{ pubkey: string; created_at: number; content: string }>) => {
    const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0];
    return latest ? { pubkey: latest.pubkey, profile: JSON.parse(latest.content) } : undefined;
  },
}));
vi.mock('nostr-tools', () => ({ verifyEvent: () => true }));

import { createIdentityProfileNameStore } from '../src/stores/identityProfile';

const nameEvent = (name: string, createdAt: number) => ({ kind: 0, pubkey: REPRESENTATIVE, created_at: createdAt, content: JSON.stringify({ name }) });

describe('identity profile name', () => {
  let handlers: Record<string, (event?: unknown) => void>;
  const stop = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    stop.mockReset();
    stopDirect.mockReset();
    directMock.mockReset();
    directMock.mockReturnValue(stopDirect);
    subscribeMock.mockReset();
    subscribeMock.mockReturnValue({
      on(name: string, handler: (event?: unknown) => void) { handlers[name] = handler; return this; },
      stop,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a name that arrives after the relays reported the end of their history', async () => {
    const store = createIdentityProfileNameStore('profile', '1'.repeat(64));
    const fallbackName = get(store).fallbackName;
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    // No option that ends the lookup at the first history answer.
    expect(subscribeMock.mock.calls[0][1]).toBeUndefined();

    // The worker is busy: the history ends empty, and the lookup keeps listening.
    await vi.advanceTimersByTimeAsync(10000);
    handlers.history({ complete: false, reason: 'timeout' });
    expect(stop).not.toHaveBeenCalled();
    expect(get(store)).toMatchObject({ name: fallbackName, loading: false });

    handlers.event(nameEvent('Alice', 100));
    expect(get(store).name).toBe('Alice');

    await vi.advanceTimersByTimeAsync(1600);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(get(store)).toMatchObject({ name: 'Alice', loading: false });
  });

  it('asks the relays directly when the worker has not answered after a moment', async () => {
    const store = createIdentityProfileNameStore('profile', '2'.repeat(64));
    await vi.advanceTimersByTimeAsync(1400);
    expect(directMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(directMock).toHaveBeenCalledTimes(1);
    expect(directMock.mock.calls[0][0]).toEqual([{ kinds: [0], authors: [REPRESENTATIVE] }]);

    directMock.mock.calls[0][1](nameEvent('Bob', 50));
    expect(get(store).name).toBe('Bob');
    await vi.advanceTimersByTimeAsync(1600);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopDirect).toHaveBeenCalledTimes(1);
  });
});
