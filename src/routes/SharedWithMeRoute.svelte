<script lang="ts">
  import SharedWithMePanel from '../components/SharedWithMePanel.svelte';
</script>

<main class="flex-1 min-w-0 overflow-auto bg-surface-0" data-testid="shared-with-me-view">
  <div class="flex min-h-13 items-center gap-2 border-b border-surface-2 px-3 py-2 lg:px-5 lg:py-3">
    <span class="i-lucide-users text-lg lg:text-xl text-accent shrink-0"></span>
    <h1 class="text-base lg:text-xl font-medium text-text-1">Shared with me</h1>
  </div>
  <SharedWithMePanel standalone={true} />
</main>
