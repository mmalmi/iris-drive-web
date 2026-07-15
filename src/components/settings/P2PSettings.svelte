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
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Display</h3>
    <div class="bg-surface-2 rounded divide-y divide-surface-3">
      <label class="p-3 flex items-center justify-between cursor-pointer">
        <div>
          <span class="text-sm text-text-1">Always show connectivity</span>
          <p class="text-xs text-text-3">Otherwise the header only warns when Drive is offline</p>
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
          <span class="text-sm text-text-1">Show bandwidth</span>
          <p class="text-xs text-text-3">Display transfer rates in the header when available</p>
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
      FIPS peers ({peerList.length})
    </h3>
    <p class="text-xs text-text-3 mb-3">
      Device peers discovered over Nostr and connected through authenticated FIPS WebRTC.
    </p>

    {#if peerList.length === 0}
      <div class="bg-surface-2 rounded p-3 text-sm text-muted">No FIPS peers connected</div>
    {:else}
      <div class="bg-surface-2 rounded divide-y divide-surface-3">
        {#each peerList as peer (peer.id)}
          <div class="flex items-center gap-3 p-3" data-testid="settings-fips-peer">
            <span class="w-2 h-2 rounded-full shrink-0 bg-success"></span>
            <div class="min-w-0 flex-1">
              <div class="font-mono text-sm text-text-1 truncate" title={peer.peerId}>
                {shortPeerId(peer.peerId)}
              </div>
              <div class="text-xs text-text-3">FIPS device identity</div>
            </div>
            <span class="rounded bg-surface-1 px-2 py-1 text-[10px] uppercase tracking-wide text-text-3">
              WebRTC
            </span>
            <span class="rounded bg-surface-1 px-2 py-1 text-[10px] uppercase tracking-wide text-text-3">
              Nostr discovery
            </span>
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
