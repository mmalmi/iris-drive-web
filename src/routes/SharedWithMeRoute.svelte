<script lang="ts">
  import SharedWithMePanel from '../components/SharedWithMePanel.svelte';
</script>

<main class="flex-1 min-w-0 overflow-auto bg-surface-0 px-4 py-5 md:px-6" data-testid="shared-with-me-view">
  <h1 class="mb-5 text-xl font-medium text-text-1">Shared with me</h1>
  <SharedWithMePanel standalone={true} />
</main>
