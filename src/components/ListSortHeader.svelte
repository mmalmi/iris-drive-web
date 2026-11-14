<script lang="ts">
  /**
   * Above a folder's list: how it is sorted, from a small menu of Name, Last
   * modified and Size, and the names of its columns, which sort by them too.
   * Choosing how it already is sorted turns the order around. The choice is
   * kept on this device.
   */
  import Menu, { type MenuItem } from './ui/Menu.svelte';
  import { saveSort, type ListSort, type SortKey } from '../lib/fileListSort';

  interface Props {
    sort: ListSort;
  }

  let { sort = $bindable() }: Props = $props();

  const LABELS: Record<SortKey, string> = { name: 'Name', modified: 'Last modified', size: 'Size' };
  const ICONS: Record<SortKey, string> = { name: 'i-lucide-case-sensitive', modified: 'i-lucide-clock', size: 'i-lucide-hard-drive' };
  const WAYS: Record<SortKey, [string, string]> = {
    name: ['A to Z', 'Z to A'],
    modified: ['oldest first', 'newest first'],
    size: ['smallest first', 'largest first'],
  };

  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let arrow = $derived(sort.descending ? 'i-lucide-arrow-down' : 'i-lucide-arrow-up');

  /** The other way round when it already is sorted so, else newest or largest first, names A to Z. */
  function sortBy(by: SortKey) {
    sort = { by, descending: sort.by === by ? !sort.descending : by !== 'name' };
    saveSort(sort);
  }

  let items = $derived((['name', 'modified', 'size'] as SortKey[]).map((by): MenuItem => ({
    label: LABELS[by],
    icon: sort.by === by ? arrow : ICONS[by],
    testid: `sort-by-${by}`,
    run: () => sortBy(by),
  })));

  const column = 'hidden sm:flex shrink-0 h-8 items-center gap-1 p-0 b-0 bg-transparent cursor-pointer text-text-3 hover:text-text-1';
</script>

<div class="shrink-0 flex items-center gap-3 h-10 border-b border-surface-2 bg-surface-0 text-sm text-text-3" data-testid="list-header">
  <div class="relative flex-1 min-w-0 pl-1 lg:pl-3">
    <button
      bind:this={button}
      type="button"
      class="flex items-center gap-1 h-8 px-2 rounded-full b-0 bg-transparent cursor-pointer text-text-2 hover:text-text-1 hover:bg-surface-2"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Sort by {LABELS[sort.by]}, {WAYS[sort.by][Number(sort.descending)]}"
      data-testid="sort-menu-btn"
      onclick={() => { open = !open; }}
    >
      {LABELS[sort.by]}<span class="{arrow} text-sm"></span>
    </button>
    {#if open}
      <Menu
        {items}
        label="Sort by"
        heading="Sort by"
        align="left"
        width="w-48"
        sheet={window.innerWidth < 640}
        inside={[button]}
        testid="sort-menu"
        onClose={(returnFocus) => { open = false; if (returnFocus) button?.focus(); }}
      />
    {/if}
  </div>
  <button type="button" class="{column} w-32" onclick={() => sortBy('modified')}>
    Last modified{#if sort.by === 'modified'}<span class="{arrow} text-sm"></span>{/if}
  </button>
  <button type="button" class="{column} w-20 justify-end" onclick={() => sortBy('size')}>
    {#if sort.by === 'size'}<span class="{arrow} text-sm"></span>{/if}File size
  </button>
  <!-- Where the rows have their ⋮. -->
  <span class="shrink-0 w-[34px] lg:w-[40px]"></span>
</div>
