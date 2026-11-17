<script lang="ts">
  import { blossomLogStore } from '../../stores/blossomLog';
  import { appStore, formatBytes } from '../../store';

  let bandwidth = $derived($appStore.blossomBandwidth);
</script>

<details class="mt-3">
  <summary class="cursor-pointer text-sm text-text-2">File server activity</summary>
  <div class="mt-2 bg-surface-2 rounded p-3">
    <div class="text-xs text-text-3 mb-2">This session</div>
    <div class="grid grid-cols-2 gap-3 text-sm">
      <div>
        <div class="text-xs text-text-3">Upload</div>
        <div class="font-mono text-success">{formatBytes(bandwidth.totalBytesSent)}</div>
      </div>
      <div>
        <div class="text-xs text-text-3">Download</div>
        <div class="font-mono text-accent">{formatBytes(bandwidth.totalBytesReceived)}</div>
      </div>
    </div>
  </div>

  {#if $blossomLogStore.length > 0}
    <div class="mt-3">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs text-text-3">Recent activity</span>
        <button onclick={() => blossomLogStore.clear()} class="btn-ghost text-xs text-text-3">Clear</button>
      </div>
      <div class="bg-surface-3 rounded text-xs font-mono max-h-32 overflow-y-auto overflow-x-auto p-2 space-y-1">
        {#each $blossomLogStore as log (log.timestamp + log.hash)}
          {@const time = new Date(log.timestamp).toLocaleTimeString()}
          <div class="flex items-center gap-2 whitespace-nowrap {log.success ? 'text-success' : 'text-danger'}">
            <span class="text-text-3">{time}</span>
            <span>{log.operation.toUpperCase()}</span>
            <span class="text-text-2">{log.server}</span>
            <span class="text-text-3">{log.hash.slice(0, 8)}...</span>
            {#if log.success && log.bytes}
              <span class="text-text-3">{log.bytes}B</span>
            {:else if log.error}
              <span>{log.error}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</details>
