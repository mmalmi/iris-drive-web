<script lang="ts">
  /**
   * Bandwidth indicator - shows current upload/download rates in header
   */
  import { appStore, getBandwidthUsageTotals } from '../store';
  import { onDestroy, onMount } from 'svelte';

  let currentTotals = $derived.by(() => {
    $appStore;
    return readTotals();
  });
  let prevBytes = $state<{ sent: number; received: number; time: number } | null>(null);
  let rates = $state({ up: 0, down: 0 });
  let interval: ReturnType<typeof setInterval> | null = null;

  function readTotals() {
    const totals = getBandwidthUsageTotals();
    return {
      sent: totals.totalBytesSent,
      received: totals.totalBytesReceived,
    };
  }

  function resetBaseline(totals = currentTotals) {
    prevBytes = {
      sent: totals.sent,
      received: totals.received,
      time: Date.now(),
    };
  }

  function sampleRates() {
    const now = Date.now();

    if (!prevBytes) {
      resetBaseline();
      return;
    }

    if (currentTotals.sent < prevBytes.sent || currentTotals.received < prevBytes.received) {
      rates = { up: 0, down: 0 };
      resetBaseline();
      return;
    }

    const elapsedMs = now - prevBytes.time;
    if (elapsedMs <= 0) return;
    const elapsed = elapsedMs / 1000;

    rates = {
      up: Math.max(0, (currentTotals.sent - prevBytes.sent) / elapsed),
      down: Math.max(0, (currentTotals.received - prevBytes.received) / elapsed),
    };

    prevBytes = {
      sent: currentTotals.sent,
      received: currentTotals.received,
      time: now,
    };
  }

  $effect(() => {
    if (prevBytes && (currentTotals.sent < prevBytes.sent || currentTotals.received < prevBytes.received)) {
      rates = { up: 0, down: 0 };
      resetBaseline();
    }
  });

  onMount(() => {
    resetBaseline();
    interval = setInterval(sampleRates, 1000);
  });

  onDestroy(() => {
    if (interval) clearInterval(interval);
  });

  function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return `${Math.round(bytesPerSec).toString().padStart(4)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1).padStart(4)} kB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1).padStart(4)} MB/s`;
  }
</script>

<a
  href="#/settings/network/p2p"
  data-testid="bandwidth-indicator"
  class="flex flex-col items-end text-xs no-underline font-mono leading-tight w-24 whitespace-nowrap"
  title="Upload: {formatRate(rates.up)}, Download: {formatRate(rates.down)}"
>
  <span class="flex items-center gap-0.5" class:text-green-400={rates.up > 0} class:text-text-3={rates.up === 0}>
    <span>{formatRate(rates.up)}</span>
    <span class="i-lucide-arrow-up text-xs"></span>
  </span>
  <span class="flex items-center gap-0.5" class:text-blue-400={rates.down > 0} class:text-text-3={rates.down === 0}>
    <span>{formatRate(rates.down)}</span>
    <span class="i-lucide-arrow-down text-xs"></span>
  </span>
</a>
