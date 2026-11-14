<script lang="ts">
  let { grid = $bindable() }: { grid: boolean } = $props();

  function choose(value: boolean) {
    grid = value;
    try { localStorage.setItem('iris-drive:folder-view', value ? 'grid' : 'list'); } catch { /* Private browsing. */ }
  }
</script>

<script module lang="ts">
  export function loadGridView(): boolean {
    try { return localStorage.getItem('iris-drive:folder-view') === 'grid'; } catch { return false; }
  }
</script>

<div class="inline-flex shrink-0 rounded-full border border-surface-3 p-0.5" role="group" aria-label="Folder view">
  {#each [false, true] as value}
    <button
      type="button"
      class="w-9 h-7 flex items-center justify-center rounded-full b-0 cursor-pointer {value === grid ? 'bg-accent/15 text-accent' : 'bg-transparent text-text-3 hover:bg-surface-2 hover:text-text-1'}"
      title={value ? 'Grid view' : 'List view'}
      aria-label={value ? 'Grid view' : 'List view'}
      aria-pressed={value === grid}
      onclick={() => choose(value)}
    ><span class={value ? 'i-lucide-grid-2x2' : 'i-lucide-list'}></span></button>
  {/each}
</div>
