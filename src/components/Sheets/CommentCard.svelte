<script lang="ts">
  /** The comments on the selected cell, in a card beside it; on a phone, along the bottom. */
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { threadsAt } from '../../lib/sheets/comments';
  import { columnX, rowY, type Viewport } from '../../lib/sheets/layout';
  import CommentThreads from './CommentThreads.svelte';

  interface Props {
    ctl: SheetController;
    view: Viewport;
  }
  let { ctl, view }: Props = $props();

  const CARD_WIDTH = 300;

  let activeKey = $derived(ctl.hasSheet ? `${ctl.sheet.rows.ids[ctl.active.row]}:${ctl.sheet.cols.ids[ctl.active.col]}` : '');
  let threads = $derived.by(() => {
    void ctl.revision;
    // Resolved threads are in the list of all comments, not beside the cell.
    return ctl.hasSheet ? threadsAt(ctl.sheet, ctl.active.row, ctl.active.col).filter(thread => !thread.resolved) : [];
  });
  let open = $derived(ctl.commentFor !== null && ctl.commentFor.cell === activeKey);
  let compose = $derived(!!ctl.commentFor?.compose && ctl.canEdit);

  // Moving to another cell closes the card; a thread that was the cell's last one going away too.
  $effect(() => {
    if (ctl.commentFor && (ctl.commentFor.cell !== activeKey || (!ctl.commentFor.compose && threads.length === 0))) ctl.commentFor = null;
  });

  let phone = $derived(view.width <= 640);
  let place = $derived.by(() => {
    if (phone) return '';
    const block = ctl.activeRect;
    const right = columnX(view, block.c2) + view.cols.size(block.c2);
    const top = Math.max(28, Math.min(rowY(view, block.r1), view.height - 220));
    if (right + 8 + CARD_WIDTH <= view.width) return `left: ${right + 8}px; top: ${top}px`;
    const left = columnX(view, block.c1) - 8 - CARD_WIDTH;
    if (left >= view.headerWidth) return `left: ${left}px; top: ${top}px`;
    return `left: ${Math.max(view.headerWidth, view.width - CARD_WIDTH - 8)}px; top: ${rowY(view, block.r2) + view.rows.size(block.r2) + 6}px`;
  });

  function close(): void {
    ctl.commentFor = null;
    ctl.focusGrid();
  }
</script>

{#if open && (threads.length > 0 || compose)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section class="card" class:phone style={place} aria-label="Comments" data-testid="comment-card" onkeydown={(event) => { if (event.key === 'Escape') close(); }}>
    <button class="close" onclick={close} title="Close" aria-label="Close comments"><span class="i-lucide-x"></span></button>
    <CommentThreads {ctl} {threads} cell={activeKey} {compose} autofocus={compose} ondone={() => { if (ctl.commentFor) ctl.commentFor = { ...ctl.commentFor, compose: false }; if (threads.length === 0) close(); }} />
  </section>
{/if}

<style>
  .card {
    position: absolute;
    z-index: 20;
    width: 300px;
    max-height: min(420px, calc(100% - 40px));
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 30px 8px 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 10px;
    background: rgb(var(--surface-1));
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.22);
  }

  .card.phone {
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 50%;
    border-radius: 14px 14px 0 0;
  }

  .close {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: rgb(var(--text-2));
    cursor: pointer;
  }

  .close:hover {
    background: rgb(var(--surface-2));
  }
</style>
