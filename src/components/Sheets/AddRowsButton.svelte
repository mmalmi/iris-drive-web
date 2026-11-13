<script lang="ts">
  /** The button under the last row that makes the sheet longer. */
  import { appendRows } from '../../lib/sheets/commands';
  import type { SheetController } from '../../lib/sheets/controller.svelte';

  interface Props {
    ctl: SheetController;
    top: number;
    left: number;
  }
  let { ctl, top, left }: Props = $props();
</script>

<button type="button" class="add-rows" style="top: {top}px; left: {left}px" onclick={() => appendRows(ctl, 100)} data-testid="sheet-add-rows">
  <span class="i-lucide-plus"></span>
  Add 100 rows
</button>

<style>
  .add-rows {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 15px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-2));
    font-size: 0.8rem;
    cursor: pointer;
  }

  .add-rows:hover {
    background: rgb(var(--surface-2));
    color: rgb(var(--text-1));
  }

  @media (pointer: coarse) {
    .add-rows {
      height: 40px;
      border-radius: 20px;
    }
  }
</style>
