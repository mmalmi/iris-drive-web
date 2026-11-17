<script lang="ts">
  import { nostrStore, type RelayStatus } from '../../nostr';
  import { settingsStore, DEFAULT_NETWORK_SETTINGS } from '../../stores/settings';
  import { getNativeDaemonRelayUrl } from '../../nostr/client';

  let networkSettings = $derived($settingsStore.network);
  let newRelayUrl = $state('');
  let editingRelays = $state(false);

  let relayStatuses = $derived($nostrStore.relayStatuses);
  let transportRelays = $derived($nostrStore.transportRelays);
  let discoveredRelays = $derived($nostrStore.discoveredRelays);
  let showDiscoveredRelays = $state(false);
  let showUpstreamRelays = $state(false);
  const nativeDaemonRelayUrl = getNativeDaemonRelayUrl();
  const usesEmbeddedDaemonRelay = !!nativeDaemonRelayUrl;

  function getStatusColor(status: RelayStatus): string {
    switch (status) {
      case 'connected': return 'bg-success';
      case 'connecting': return 'bg-warning';
      case 'error': return 'bg-danger';
      default: return 'bg-text-3';
    }
  }

  function getRelayStatus(url: string): RelayStatus {
    const normalized = url.replace(/\/$/, '');
    return relayStatuses.get(normalized) || relayStatuses.get(url) || 'disconnected';
  }

  function formatServerLabel(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function addRelay() {
    const url = newRelayUrl.trim();
    if (!url) return;
    try {
      new URL(url);
      if (!url.startsWith('wss://') && !url.startsWith('ws://')) return;
    } catch { return; }
    if (!networkSettings.relays.includes(url)) {
      settingsStore.setNetworkSettings({ relays: [...networkSettings.relays, url] });
    }
    newRelayUrl = '';
  }

  function removeRelay(url: string) {
    settingsStore.setNetworkSettings({ relays: networkSettings.relays.filter(r => r !== url) });
  }

  function resetRelays() {
    settingsStore.setNetworkSettings({ relays: DEFAULT_NETWORK_SETTINGS.relays });
    editingRelays = false;
  }

  function formatRelayRole(url: string): string {
    if (nativeDaemonRelayUrl && url === nativeDaemonRelayUrl) {
      return 'Relay in the Iris app on this device';
    }
    return 'Relay';
  }
</script>

<div>
  <div class="flex items-center justify-between mb-1">
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide">
      Relays
    </h3>
    <button onclick={() => editingRelays = !editingRelays} class="btn-ghost text-xs">
      {editingRelays ? 'Done' : usesEmbeddedDaemonRelay ? 'Edit upstream' : 'Edit'}
    </button>
  </div>
  <p class="text-xs text-text-3 mb-3">
    {usesEmbeddedDaemonRelay
      ? 'Connected through the Iris app on this device, which uses the relays below'
      : 'Servers that carry messages between your devices and the people you share with'}
  </p>
  {#if usesEmbeddedDaemonRelay}
    <div class="bg-surface-2 rounded divide-y divide-surface-3">
      {#if transportRelays.length > 0}
        {#each transportRelays as relay (relay.url)}
          <div class="flex items-center gap-2 p-3 text-sm">
            <span class="w-2 h-2 rounded-full {getStatusColor(relay.status)} shrink-0"></span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-text-1">{relay.url}</div>
              <div class="truncate text-xs text-text-3">{formatRelayRole(relay.url)}</div>
            </div>
            <span class="text-xs text-text-3">{relay.status.charAt(0).toUpperCase() + relay.status.slice(1)}</span>
          </div>
        {/each}
      {:else}
        <div class="p-3 text-sm text-text-3">Not connected</div>
      {/if}
    </div>

    <div class="bg-surface-2 rounded mt-1">
      <button
        onclick={() => showUpstreamRelays = !showUpstreamRelays}
        class="btn-ghost b-0 flex items-center gap-1 p-3 text-sm text-text-1 w-full"
      >
        <span class="i-lucide-chevron-right text-sm transition-transform {(showUpstreamRelays || editingRelays) ? 'rotate-90' : ''}"></span>
        Configured upstream relays ({networkSettings.relays.length})
      </button>
      {#if showUpstreamRelays || editingRelays}
        <div class="divide-y divide-surface-3">
          {#each networkSettings.relays as relay (relay)}
            <div class="flex items-center gap-2 p-3 text-sm">
              <span class="w-2 h-2 rounded-full bg-text-3 shrink-0"></span>
              <span class="text-text-1 truncate flex-1">{formatServerLabel(relay)}</span>
              {#if editingRelays}
                <button onclick={() => removeRelay(relay)} class="btn-ghost p-1 text-danger" title="Remove relay">
                  <span class="i-lucide-x text-sm"></span>
                </button>
              {:else}
                <span class="text-xs text-text-3">Set by the Iris app</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="bg-surface-2 rounded divide-y divide-surface-3">
      {#each networkSettings.relays as relay (relay)}
        {@const status = getRelayStatus(relay)}
        <div class="flex items-center gap-2 p-3 text-sm">
          <span class="w-2 h-2 rounded-full {getStatusColor(status)} shrink-0"></span>
          <span class="text-text-1 truncate flex-1">{formatServerLabel(relay)}</span>
          {#if editingRelays}
            <button onclick={() => removeRelay(relay)} class="btn-ghost p-1 text-danger" title="Remove relay">
              <span class="i-lucide-x text-sm"></span>
            </button>
          {:else}
            <span class="text-xs text-text-3">{status.charAt(0).toUpperCase() + status.slice(1)}</span>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Discovered Relays -->
    {#if discoveredRelays.length > 0}
      <div class="bg-surface-2 rounded mt-1">
        <button
          onclick={() => showDiscoveredRelays = !showDiscoveredRelays}
          class="btn-ghost b-0 flex items-center gap-1 p-3 text-sm text-text-1 w-full"
        >
          <span class="i-lucide-chevron-right text-sm transition-transform {showDiscoveredRelays ? 'rotate-90' : ''}"></span>
          Discovered relays ({discoveredRelays.length})
        </button>
        {#if showDiscoveredRelays}
          <div class="divide-y divide-surface-3">
            {#each discoveredRelays as relay (relay.url)}
              <div class="flex items-center gap-2 p-3 text-sm">
                <span class="w-2 h-2 rounded-full {getStatusColor(relay.status)} shrink-0"></span>
                <span class="text-text-1 truncate flex-1">{formatServerLabel(relay.url)}</span>
                <span class="text-xs text-text-3">{relay.status.charAt(0).toUpperCase() + relay.status.slice(1)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if editingRelays}
    <div class="mt-2 flex gap-2">
      <input
        type="text"
        bind:value={newRelayUrl}
        placeholder="wss://relay.example.com"
        class="flex-1 input text-sm"
        onkeydown={(e) => e.key === 'Enter' && addRelay()}
      />
      <button onclick={addRelay} class="btn-primary text-sm">Add</button>
    </div>
    <button onclick={resetRelays} class="btn-ghost mt-2 text-xs text-text-3">Reset to defaults</button>
  {/if}
</div>
