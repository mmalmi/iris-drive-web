import { nostrStore } from './store';
import { settingsStore, DEFAULT_NETWORK_SETTINGS } from '../stores/settings';
import { getWorkerAdapter } from '../lib/workerInit';
import {
  buildRelayStatusSnapshot,
  relayInfoListsEqual,
  relayStatusMapsEqual,
} from './relayStatusSnapshot';

export { normalizeRelayUrl } from './relayStatusSnapshot';

let relayTrackingInitialized = false;

/**
 * Update relay status by polling the current adapter. In native mode this is
 * the main-thread NDK transport; in web mode it is the worker relay pool.
 */
export async function updateConnectedRelayCount(): Promise<void> {
  const adapter = getWorkerAdapter();
  if (!adapter) {
    const state = nostrStore.getState();
    if (state.connectedRelays !== 0) {
      nostrStore.setConnectedRelays(0);
    }
    if (state.transportRelays.length !== 0) {
      nostrStore.setTransportRelays([]);
    }
    return;
  }

  try {
    const stats = await adapter.getRelayStats();

    // Get configured relays from settings or use defaults
    const settings = settingsStore.getState();
    const configuredRelays = settings.network?.relays?.length > 0
      ? settings.network.relays
      : DEFAULT_NETWORK_SETTINGS.relays;

    const snapshot = buildRelayStatusSnapshot(configuredRelays, stats);

    const state = nostrStore.getState();
    if (state.connectedRelays !== snapshot.connectedRelays) {
      nostrStore.setConnectedRelays(snapshot.connectedRelays);
    }
    if (!relayStatusMapsEqual(state.relayStatuses, snapshot.relayStatuses)) {
      nostrStore.setRelayStatuses(snapshot.relayStatuses);
    }
    if (!relayInfoListsEqual(state.transportRelays, snapshot.transportRelays)) {
      nostrStore.setTransportRelays(snapshot.transportRelays);
    }
    if (!relayInfoListsEqual(state.discoveredRelays, snapshot.discoveredRelays)) {
      nostrStore.setDiscoveredRelays(snapshot.discoveredRelays);
    }
  } catch (err) {
    console.error('[Relays] Failed to get relay stats:', err);
  }
}

/**
 * Initialize relay tracking
 * Polls worker periodically for relay status updates.
 */
export function initRelayTracking(): void {
  if (relayTrackingInitialized) return;
  relayTrackingInitialized = true;

  // Poll immediately
  void updateConnectedRelayCount();

  // Poll frequently for first 5 seconds (every 200ms), then slow down
  let pollCount = 0;
  const fastPollInterval = setInterval(() => {
    pollCount++;
    void updateConnectedRelayCount();
    if (pollCount >= 25) {
      // 25 * 200ms = 5 seconds
      clearInterval(fastPollInterval);
    }
  }, 200);

  // Regular polling after initial burst
  setInterval(updateConnectedRelayCount, 2000);
}
