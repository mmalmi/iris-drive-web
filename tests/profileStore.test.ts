import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const { subscribeMock } = vi.hoisted(() => ({ subscribeMock: vi.fn() }));

vi.mock('../src/nostr/client', () => ({
  nostr: { subscribe: subscribeMock },
}));

// The direct-to-relay path opens real sockets; here it is a stand-in that records what it was asked.
const { directMock, stopDirect } = vi.hoisted(() => ({ directMock: vi.fn(), stopDirect: vi.fn() }));
vi.mock('../src/nostr/directQuery', () => ({ queryConfiguredRelaysDirectly: directMock }));

import { createProfileStore } from '../src/stores/profile';

const ALICE = '1'.repeat(64);
const BOB = '2'.repeat(64);
const CAROL = '3'.repeat(64);
const DAVE = '4'.repeat(64);
const ERIN = '5'.repeat(64);
const FRANK = '6'.repeat(64);
const GRACE = '7'.repeat(64);
const HEIDI = '8'.repeat(64);
const IVAN = '9'.repeat(64);

function profileEvent(pubkey: string, name: string, createdAt: number) {
  return { kind: 0, pubkey, created_at: createdAt, tags: [], content: JSON.stringify({ name }) };
}

describe('profile store', () => {
  let handlers: Record<string, (event: ReturnType<typeof profileEvent>) => void>;
  const stop = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {};
    stop.mockReset();
    subscribeMock.mockReset();
    directMock.mockReset();
    directMock.mockReturnValue(stopDirect);
    stopDirect.mockReset();
    subscribeMock.mockReturnValue({
      on(name: string, handler: (event: ReturnType<typeof profileEvent>) => void) { handlers[name] = handler; return this; },
      stop,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks up a page of profiles with one subscription and applies relay answers as they come', () => {
    const alice = createProfileStore(ALICE);
    const bob = createProfileStore(BOB);
    const seen: Array<string | undefined> = [];
    const unsubscribe = alice.subscribe((profile) => seen.push(profile?.name));

    vi.advanceTimersByTime(150);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock.mock.calls[0][0]).toEqual({ kinds: [0], authors: [ALICE, BOB] });
    // No option that ends the lookup at the first (local, often empty) history answer.
    expect(subscribeMock.mock.calls[0][1]).toBeUndefined();

    // A relay answers a couple of seconds later; an older copy from another relay does not win.
    vi.advanceTimersByTime(2000);
    handlers.event(profileEvent(ALICE, 'Alice', 200));
    handlers.event(profileEvent(ALICE, 'Old Alice', 100));
    expect(seen).toEqual([undefined, 'Alice']);
    expect(get(bob)).toBeUndefined();

    // Bob's answer is stuck behind a backlog: the lookup is still listening ten seconds on.
    vi.advanceTimersByTime(10000);
    expect(stop).not.toHaveBeenCalled();
    handlers.event(profileEvent(BOB, 'Bob', 50));
    expect(get(createProfileStore(BOB))?.name).toBe('Bob');

    // Everyone answered: after a moment for newer copies the relay gets its slot back.
    vi.advanceTimersByTime(1000);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(stop).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('opens a few lookups side by side, gives up on silence, and asks again later', () => {
    createProfileStore(CAROL);
    vi.advanceTimersByTime(150);
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    // Asked for while Carol's lookup is open: Dave goes out at once, Carol is not repeated.
    createProfileStore(CAROL);
    createProfileStore(DAVE);
    vi.advanceTimersByTime(150);
    expect(subscribeMock).toHaveBeenCalledTimes(2);
    expect(subscribeMock.mock.calls[1][0]).toEqual({ kinds: [0], authors: [DAVE] });

    // No more than three are open at once; the fourth waits for a slot.
    createProfileStore(ERIN);
    vi.advanceTimersByTime(150);
    createProfileStore(FRANK);
    vi.advanceTimersByTime(150);
    expect(subscribeMock).toHaveBeenCalledTimes(3);

    // Nobody answers: each lookup is given up after twenty seconds, freeing a slot for Frank.
    vi.advanceTimersByTime(20000);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(subscribeMock).toHaveBeenCalledTimes(4);
    expect(subscribeMock.mock.calls[3][0]).toEqual({ kinds: [0], authors: [FRANK] });

    // Carol was not found: a later request looks her up again.
    createProfileStore(CAROL);
    vi.advanceTimersByTime(150);
    expect(subscribeMock).toHaveBeenCalledTimes(5);
    expect(subscribeMock.mock.calls[4][0]).toEqual({ kinds: [0], authors: [CAROL] });
  });

  it('asks the relays directly for whoever the worker has not answered after a moment', () => {
    const grace = createProfileStore(GRACE);
    createProfileStore(HEIDI);
    vi.advanceTimersByTime(150);
    handlers.event(profileEvent(HEIDI, 'Heidi', 10));

    // The worker is busy: Grace's answer is not coming through it any time soon.
    expect(directMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(directMock).toHaveBeenCalledTimes(1);
    expect(directMock.mock.calls[0][0]).toEqual([{ kinds: [0], authors: [GRACE] }]);

    // A relay answers on its own connection; the worker's late, older copy does not replace it.
    directMock.mock.calls[0][1](profileEvent(GRACE, 'Grace', 300));
    expect(get(grace)?.name).toBe('Grace');
    handlers.event(profileEvent(GRACE, 'Old Grace', 100));
    expect(get(grace)?.name).toBe('Grace');

    vi.advanceTimersByTime(1600);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopDirect).toHaveBeenCalledTimes(1);
  });

  it('leaves the relays alone when the worker answers in time', () => {
    createProfileStore(IVAN);
    vi.advanceTimersByTime(150);
    handlers.event(profileEvent(IVAN, 'Ivan', 10));
    vi.advanceTimersByTime(5000);
    expect(directMock).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
