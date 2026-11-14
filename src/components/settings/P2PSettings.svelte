<script lang="ts">
  import { settingsStore } from '../../stores/settings';
  import { appStore, refreshFipsStats } from '../../store';

  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();
  let poolSettings = $derived($settingsStore.pools);
  let peerList = $derived($appStore.peers.filter((peer) => peer.state === 'connected'));

  $effect(() => {
    void refreshFipsStats();
    const interval = window.setInterval(() => void refreshFipsStats(), 1_000);
    return () => window.clearInterval(interval);
  });

  function shortPeerId(peerId: string): string {
    return peerId.length > 20
      ? `${peerId.slice(0, 12)}…${peerId.slice(-8)}`
      : peerId;
  }
</script>

<div class:root-layout={!embedded} class:embedded-layout={embedded}>
  <section>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Top bar</h3>
    <div class="bg-surface-2 rounded divide-y divide-surface-3">
      <label class="p-3 flex items-center justify-between cursor-pointer">
        <div>
          <span class="text-sm text-text-1">Always show connection status</span>
          <p class="text-xs text-text-3">Otherwise it only shows when Drive is offline</p>
        </div>
        <input
          type="checkbox"
          checked={poolSettings.showConnectivity ?? false}
          onchange={(event) => settingsStore.setPoolSettings({ showConnectivity: event.currentTarget.checked })}
          class="w-4 h-4 accent-accent"
        />
      </label>
      <label class="p-3 flex items-center justify-between cursor-pointer">
        <div>
          <span class="text-sm text-text-1">Show transfer speed</span>
          <p class="text-xs text-text-3">Upload and download speed, when there is any</p>
        </div>
        <input
          type="checkbox"
          checked={poolSettings.showBandwidth ?? false}
          onchange={(event) => settingsStore.setPoolSettings({ showBandwidth: event.currentTarget.checked })}
          class="w-4 h-4 accent-accent"
        />
      </label>
    </div>
  </section>

  <section data-testid="settings-fips-peers">
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">
      Direct connections ({peerList.length})
    </h3>
    <p class="text-xs text-text-3 mb-3">
      Devices running Iris that this one exchanges data with directly, without a server in between.
      Found through relays and connected over WebRTC (FIPS).
    </p>

    {#if peerList.length === 0}
      <div class="bg-surface-2 rounded p-3 text-sm text-muted">No direct connections</div>
    {:else}
      <div class="bg-surface-2 rounded divide-y divide-surface-3">
        {#each peerList as peer (peer.id)}
          <div class="flex items-center gap-3 p-3" data-testid="settings-fips-peer">
            <span class="w-2 h-2 rounded-full shrink-0 bg-success"></span>
            <div class="min-w-0 flex-1">
              <div class="font-mono text-sm text-text-1 truncate" title={peer.peerId}>
                {shortPeerId(peer.peerId)}
              </div>
              <div class="text-xs text-text-3">Device</div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .root-layout {
    padding: 1rem;
    max-width: 42rem;
    margin: 0 auto;
  }

  .embedded-layout {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
</style>
