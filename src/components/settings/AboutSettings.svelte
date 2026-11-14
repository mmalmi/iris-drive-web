<script lang="ts">
  /** What this app is and when it was last updated, and a way to load it again. */
  import { buildTimeLabel } from './buildTime';
</script>

<div class="space-y-6" data-testid="about-settings">
  <section class="bg-surface-2 rounded p-3 text-sm space-y-3">
    <div class="flex items-center gap-3">
      <img src="./iris-drive-icon.svg" alt="" class="h-10 w-10 shrink-0" />
      <div class="min-w-0">
        <div class="font-medium text-text-1">Iris Drive</div>
        <div class="text-xs text-text-3">Files, documents, spreadsheets and presentations, private and in sync on all your devices.</div>
      </div>
    </div>
    <div class="flex justify-between items-center gap-3 border-t border-surface-3 pt-3">
      <span class="text-muted">Updated</span>
      <span class="text-text-1 text-xs" data-testid="about-updated">{buildTimeLabel()}</span>
    </div>
    <button
      onclick={() => window.location.reload()}
      class="btn-ghost w-full flex items-center justify-center gap-2"
      data-testid="settings-refresh-app"
    >
      <span class="i-lucide-refresh-cw text-sm"></span>
      <span>Refresh app</span>
    </button>
  </section>
</div>
