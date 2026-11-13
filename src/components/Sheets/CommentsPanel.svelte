<script lang="ts">
  /** Every comment on the sheet, by cell; open ones first. */
  import { cellName } from '../../lib/sheets/address';
  import { liveThreads } from '../../lib/sheets/comments';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import CommentThreads from './CommentThreads.svelte';
  import SidePanel from './SidePanel.svelte';

  interface Props {
    ctl: SheetController;
    onclose: () => void;
  }
  let { ctl, onclose }: Props = $props();

  let showResolved = $state(false);
  let threads = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? liveThreads(ctl.sheet) : [];
  });
  let open = $derived(threads.filter(thread => !thread.resolved));
  let resolvedCount = $derived(threads.length - open.length);
  let shown = $derived(showResolved ? threads : open);

  function placeOf(cell: string): { row: number; col: number } {
    const at = cell.indexOf(':');
    return { row: ctl.sheet.rows.indexOf(cell.slice(0, at)), col: ctl.sheet.cols.indexOf(cell.slice(at + 1)) };
  }

  function show(cell: string): void {
    const { row, col } = placeOf(cell);
    if (row < 0 || col < 0) return;
    ctl.select({ row, col });
    ctl.reveal(row, col);
  }
</script>

<SidePanel title="Comments" {onclose} testId="comments-panel">
  {#if shown.length === 0}
    <p class="hint">{threads.length === 0 ? 'No comments on this sheet yet.' : 'No open comments.'}{#if ctl.canEdit} Right-click a cell and choose Comment to add one.{/if}</p>
  {/if}
  {#each shown as thread (thread.id)}
    {@const at = placeOf(thread.cell)}
    <div class="entry">
      <button class="cell" onclick={() => show(thread.cell)} data-testid="comments-cell">{cellName(at.row, at.col)}</button>
      <CommentThreads {ctl} threads={[thread]} cell={thread.cell} showResolved />
    </div>
  {/each}
  {#if resolvedCount > 0}
    <label class="check">
      <input type="checkbox" bind:checked={showResolved} data-testid="comments-show-resolved" />
      Show resolved ({resolvedCount})
    </label>
  {/if}
</SidePanel>

<style>
  .entry {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cell {
    align-self: flex-start;
    padding: 1px 8px;
    border: none;
    border-radius: 10px;
    background: rgb(var(--surface-2));
    color: rgb(var(--text-1));
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
  }
</style>
