<script lang="ts">
  import { formatBytes } from '../../store';
  import {
    TRANSPORT_KINDS,
    getTransportUsageTotals,
    transportUsageStore,
    type TransportKind,
  } from '../../stores/transportUsage';

  interface Props {
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();
  let usageState = $derived($transportUsageStore);
  const labels: Record<TransportKind, string> = {
    relay: 'Relay',
    blossom: 'Blossom',
    webrtc: 'WebRTC',
    bluetooth: 'Bluetooth',
  };

  let totals = $derived(getTransportUsageTotals(usageState));
  let rows = $derived.by(() => {
    return TRANSPORT_KINDS
      .filter((transport) => transport !== 'bluetooth'
        || usageState.session[transport].bytesSent > 0
        || usageState.session[transport].bytesReceived > 0
        || usageState.lifetime[transport].bytesSent > 0
        || usageState.lifetime[transport].bytesReceived > 0)
      .map((transport) => ({
        key: transport,
        label: labels[transport],
        session: usageState.session[transport],
        lifetime: usageState.lifetime[transport],
      }));
  });
</script>

<div class:root-layout={!embedded} class:embedded-layout={embedded}>
  <div>
    <h3 class="text-xs font-medium text-muted uppercase tracking-wide mb-1">Transferred</h3>
    <p class="text-xs text-text-3 mb-3">Persisted traffic totals on this device, grouped by transport</p>

    <div class="bg-surface-2 rounded p-3">
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div class="rounded bg-surface-1/70 p-3">
          <div class="text-xs text-text-3 mb-2">This session</div>
          <div class="font-mono text-success">↑ {formatBytes(totals.session.bytesSent)}</div>
          <div class="font-mono text-accent">↓ {formatBytes(totals.session.bytesReceived)}</div>
        </div>
        <div class="rounded bg-surface-1/70 p-3">
          <div class="text-xs text-text-3 mb-2">All time</div>
          <div class="font-mono text-success">↑ {formatBytes(totals.lifetime.bytesSent)}</div>
          <div class="font-mono text-accent">↓ {formatBytes(totals.lifetime.bytesReceived)}</div>
        </div>
      </div>

      <div class="mt-3 pt-3 border-t border-surface-3">
        <div class="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 gap-y-2 text-xs">
          <div class="text-text-3 uppercase tracking-wide">Transport</div>
          <div class="text-right text-text-3 uppercase tracking-wide">Session</div>
          <div class="text-right text-text-3 uppercase tracking-wide">All time</div>
          {#each rows as row (row.key)}
            <div class="text-sm text-text-1">{row.label}</div>
            <div class="text-right font-mono text-text-2">
              ↑ {formatBytes(row.session.bytesSent)} · ↓ {formatBytes(row.session.bytesReceived)}
            </div>
            <div class="text-right font-mono text-text-2">
              ↑ {formatBytes(row.lifetime.bytesSent)} · ↓ {formatBytes(row.lifetime.bytesReceived)}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
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
