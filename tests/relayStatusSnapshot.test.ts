import { describe, expect, it } from 'vitest';
import { buildRelayStatusSnapshot } from '../src/nostr/relayStatusSnapshot';

describe('buildRelayStatusSnapshot', () => {
  it('tracks a daemon transport relay separately from configured upstream relays', () => {
    const snapshot = buildRelayStatusSnapshot(
      ['wss://relay.damus.io', 'wss://relay.primal.net/'],
      [{ url: 'ws://127.0.0.1:21417/ws', connected: true }],
    );

    expect(snapshot.connectedRelays).toBe(1);
    expect(snapshot.transportRelays).toEqual([
      { url: 'ws://127.0.0.1:21417/ws', status: 'connected' },
    ]);
    expect(snapshot.discoveredRelays).toEqual([]);
    expect(Array.from(snapshot.relayStatuses.entries())).toEqual([
      ['wss://relay.damus.io', 'disconnected'],
      ['wss://relay.primal.net', 'disconnected'],
    ]);
  });

  it('marks configured relays as connected when the transport stats include them', () => {
    const snapshot = buildRelayStatusSnapshot(
      ['wss://relay.example.com/', 'wss://relay.other.example'],
      [
        { url: 'wss://relay.example.com', connected: true },
        { url: 'wss://relay.other.example/', connected: false },
      ],
    );

    expect(snapshot.connectedRelays).toBe(1);
    expect(snapshot.transportRelays).toEqual([
      { url: 'wss://relay.example.com', status: 'connected' },
      { url: 'wss://relay.other.example', status: 'disconnected' },
    ]);
    expect(snapshot.discoveredRelays).toEqual([]);
    expect(Array.from(snapshot.relayStatuses.entries())).toEqual([
      ['wss://relay.example.com', 'connected'],
      ['wss://relay.other.example', 'disconnected'],
    ]);
  });
});
