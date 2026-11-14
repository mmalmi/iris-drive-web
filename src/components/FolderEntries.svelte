<script module lang="ts">
  /** Folders can end on a short row. Go to the nearest column of the row above or below. */
  export function verticalGridIndex(container: HTMLElement | undefined, index: number, down: boolean): number {
    const cells = Array.from(container?.querySelectorAll<HTMLElement>('[data-entry-name]') ?? []);
    const from = cells[index];
    if (!from) return down ? 0 : cells.length - 1;
    const rows = [...new Set(cells.map((cell) => cell.offsetTop))];
    const targetTop = rows[(rows.indexOf(from.offsetTop) + (down ? 1 : rows.length - 1)) % rows.length];
    let nearest = index;
    let distance = Infinity;
    cells.forEach((cell, i) => {
      if (cell.offsetTop !== targetTop) return;
      const delta = Math.abs(cell.offsetLeft - from.offsetLeft);
      if (delta < distance) { distance = delta; nearest = i; }
    });
    return nearest;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ensureMediaStreamingReady } from '../lib/mediaStreamingSetup';

  let { grid, children }: { grid: boolean; children: Snippet<[boolean]> } = $props();
  let mediaReady = $state(false);
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  $effect(() => {
    if (grid && !saveData) void ensureMediaStreamingReady().then((ok) => { mediaReady = ok; });
  });
</script>

<div class:tile-grid={grid}>
  {@render children(mediaReady && !saveData)}
</div>

<style>
  .tile-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 11.5rem), 1fr));
    gap: 0.75rem;
    align-items: start;
    padding: 0.75rem;
  }
  .tile-grid > :global(.folder-tile + :not(.folder-tile)) { grid-column-start: 1; }
  .tile-grid > :global(div) { min-width: 0; }
  .tile-grid > :global(div > a) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    width: 100%;
    min-height: 2.75rem;
    padding: 0.625rem;
    gap: 0.55rem;
  }
  .tile-grid > :global(div > a > span:nth-child(2)) { padding-inline-end: 1.75rem; }
  .tile-grid > :global(div > input) { top: 1.375rem; left: 0.125rem; }
  .tile-grid > :global(div > button) { position: absolute; top: 0.375rem; right: 0.25rem; margin: 0; opacity: 1; }
  @media (max-width: 639px) {
    .tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; padding: 0.5rem; }
  }
</style>
