import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  network: { relays: [] as string[], blossomServers: [{ url: 'https://storage.example', read: true, write: false }] },
  stats: [] as { url: string; connected: boolean }[],
}));
vi.mock('../src/stores/settings', () => ({
  settingsStore: { getState: () => ({ network: fixture.network }) },
  DEFAULT_NETWORK_SETTINGS: { relays: ['wss://catalog.example'] },
}));
vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: () => ({ getRelayStats: async () => fixture.stats }),
}));
import { nostrStore } from '../src/nostr/store';
import { updateConnectedRelayCount } from '../src/nostr/relays';

describe('configured relay status', () => {
  beforeEach(() => { fixture.network.relays = []; fixture.stats = []; });

  it('preserves an explicit empty relay list and independent Blossom settings', async () => {
    const blossom = structuredClone(fixture.network.blossomServers);
    await updateConnectedRelayCount();
    expect([...nostrStore.getState().relayStatuses]).toEqual([]);
    expect(nostrStore.getState().transportRelays).toEqual([]);
    expect(fixture.network.blossomServers).toEqual(blossom);
  });

  it('reports the chosen local relay without adding catalog entries', async () => {
    fixture.network.relays = ['ws://127.0.0.1:18239'];
    fixture.stats = [{ url: fixture.network.relays[0], connected: true }];
    await updateConnectedRelayCount();
    expect([...nostrStore.getState().relayStatuses]).toEqual([['ws://127.0.0.1:18239', 'connected']]);
    expect(nostrStore.getState().connectedRelays).toBe(1);
  });
});
