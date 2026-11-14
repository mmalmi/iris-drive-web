<script lang="ts">
  /**
   * Where Drive keeps your files: on this device, in plain words, and how
   * much room it may take; then the backups that keep it besides. Nothing
   * here is about how it is kept.
   */
  import BackupSettings from './BackupSettings.svelte';
  import { appStore, formatBytes, updateStorageStats } from '../../store';
  import { settingsStore, DEFAULT_STORAGE_SETTINGS } from '../../stores/settings';

  let storageSettings = $derived($settingsStore.storage);
  let editingStorage = $state(false);
  let stats = $derived($appStore.stats);
  let usedPercent = $derived(Math.min(100, Math.round((stats.bytes / storageSettings.maxBytes) * 100)));

  $effect(() => {
    updateStorageStats();
  });
</script>

<div class="space-y-6" data-testid="storage-settings">
  <section class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted uppercase tracking-wide">On this device</h3>
      <button onclick={() => editingStorage = !editingStorage} class="btn-ghost text-xs">
        {editingStorage ? 'Done' : 'Edit'}
      </button>
    </div>
    <p class="text-sm text-text-2">
      Drive keeps copies of files you add or open here, so they open quickly and work offline.
    </p>
    <div class="bg-surface-2 rounded p-3 text-sm space-y-2">
      <div class="flex justify-between gap-3">
        <span class="text-muted">Used</span>
        <span class="text-text-1">
          <span data-testid="storage-size">{formatBytes(stats.bytes)}</span>
          of
          <span data-testid="storage-limit">{formatBytes(storageSettings.maxBytes)}</span>
        </span>
      </div>
      <div class="h-1.5 rounded-full bg-surface-3 overflow-hidden" role="presentation">
        <div class="h-full bg-accent" style="width: {usedPercent}%"></div>
      </div>
    </div>
    {#if editingStorage}
      <div class="bg-surface-2 rounded p-3">
        <label class="flex flex-col gap-1">
          <span class="text-xs text-text-3">Space for copies (MB)</span>
          <input
            type="number"
            min="100"
            max="10000"
            step="100"
            value={Math.round(storageSettings.maxBytes / 1024 / 1024)}
            onchange={(e) => {
              const mb = parseInt(e.currentTarget.value) || 1024;
              settingsStore.setStorageSettings({ maxBytes: mb * 1024 * 1024 });
            }}
            class="input text-sm"
            data-testid="storage-limit-input"
          />
        </label>
        <p class="text-xs text-text-3 mt-2">When it is full, what was opened longest ago is removed from this device first.</p>
      </div>
      <button onclick={() => { settingsStore.resetStorageSettings(); editingStorage = false; }} class="btn-ghost text-xs text-text-3">
        Reset to {Math.round(DEFAULT_STORAGE_SETTINGS.maxBytes / 1024 / 1024)} MB
      </button>
    {/if}
  </section>
  <BackupSettings />
</div>
