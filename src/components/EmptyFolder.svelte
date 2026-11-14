<script lang="ts">
  /** An empty folder's message: and where it can be added to, New and dropping files. */
  import NewMenu from './NewMenu.svelte';

  let { canEdit, draggingOver = false }: { canEdit: boolean; draggingOver?: boolean } = $props();
</script>

<div class="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-text-3" data-testid="empty-folder">
  {#if !draggingOver}
    <span class="i-lucide-folder-open text-4xl text-text-3/70"></span>
    <span class="text-text-2">This folder is empty</span>
    {#if canEdit}
      <NewMenu variant="empty" class="mt-2" />
      <span>or drop files here</span>
    {/if}
  {/if}
</div>
