<script lang="ts">
  /** The bar under the grid: one tab per sheet, and a few figures about the selection. */
  import { tick } from 'svelte';
  import { rectCols, rectRows } from '../../lib/sheets/address';
  import { addSheet, duplicateSheet, removeSheet } from '../../lib/sheets/commands';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { formatGeneral, formatValue, isDateFormat } from '../../lib/sheets/format';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  let renaming = $state<string | null>(null);
  let draft = $state('');
  let renameInput: HTMLInputElement | undefined = $state();
  let menu = $state.raw<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let dragging = $state<{ id: string; over: number } | null>(null);

  async function startRename(id: string): Promise<void> {
    if (!ctl.canEdit) return;
    renaming = id;
    draft = ctl.book.nameOf(id) ?? '';
    await tick();
    renameInput?.select();
  }

  function finishRename(save: boolean): void {
    const id = renaming;
    if (!id) return;
    renaming = null;
    if (save && draft.trim() && draft.trim() !== ctl.book.nameOf(id)) {
      if (!ctl.book.renameSheet(id, draft)) ctl.say('Another sheet already has that name.');
    }
    ctl.focusGrid();
  }

  function openMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    if (!ctl.canEdit) return;
    const index = ctl.sheets.findIndex(sheet => sheet.id === id);
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: event.type === 'contextmenu' ? event.clientX : bounds.left,
      y: event.type === 'contextmenu' ? event.clientY : bounds.top - 4,
      items: [
        { label: 'Rename', icon: 'i-lucide-pencil', action: () => void startRename(id), testId: 'tab-rename' },
        { label: 'Duplicate', icon: 'i-lucide-copy', action: () => duplicateSheet(ctl, id), testId: 'tab-duplicate' },
        { label: 'Move left', icon: 'i-lucide-arrow-left', action: () => ctl.book.moveSheet(id, index - 1), disabled: index === 0, divider: true, testId: 'tab-move-left' },
        { label: 'Move right', icon: 'i-lucide-arrow-right', action: () => ctl.book.moveSheet(id, index + 1), disabled: index === ctl.sheets.length - 1, testId: 'tab-move-right' },
        {
          label: 'Delete',
          icon: 'i-lucide-trash-2',
          danger: true,
          divider: true,
          disabled: ctl.sheets.length <= 1,
          testId: 'tab-delete',
          action: () => {
            if (confirm(`Delete "${ctl.book.nameOf(id)}"?`)) removeSheet(ctl, id);
          },
        },
      ],
    };
  }

  // Dragging a tab sideways moves the sheet.
  function onTabPointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0 || !ctl.canEdit || renaming) return;
    const start = event.clientX;
    const from = ctl.sheets.findIndex(sheet => sheet.id === id);
    const strip = (event.currentTarget as HTMLElement).parentElement as HTMLElement;
    const move = (moveEvent: PointerEvent) => {
      if (!dragging && Math.abs(moveEvent.clientX - start) < 8) return;
      const tabs = [...strip.querySelectorAll<HTMLElement>('[data-tab]')];
      let over = tabs.findIndex((tab) => {
        const bounds = tab.getBoundingClientRect();
        return moveEvent.clientX < bounds.left + bounds.width / 2;
      });
      if (over < 0) over = tabs.length;
      dragging = { id, over };
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const dropped = dragging;
      dragging = null;
      if (!dropped) return;
      // `over` counts among all tabs; the position wanted is among the others.
      const to = dropped.over > from ? dropped.over - 1 : dropped.over;
      if (to !== from) ctl.book.moveSheet(id, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Count, sum and average of the selected cells, when more than one is selected. */
  let summary = $derived.by(() => {
    void ctl.revision;
    if (!ctl.hasSheet || ctl.edit) return null;
    const rect = ctl.selection;
    if (rectRows(rect) * rectCols(rect) < 2) return null;
    const sheet = ctl.sheet;
    const used = sheet.usedRect();
    if (!used) return null;
    const r2 = Math.min(rect.r2, used.r2);
    const c2 = Math.min(rect.c2, used.c2);
    if ((r2 - rect.r1 + 1) * (c2 - rect.c1 + 1) > 200_000) return null;
    let count = 0;
    let numbers = 0;
    let sum = 0;
    let format: string | undefined;
    for (let row = rect.r1; row <= r2; row += 1) {
      for (let col = rect.c1; col <= c2; col += 1) {
        const value = ctl.engine.valueAt(sheet, row, col);
        if (value === null || value === '') continue;
        count += 1;
        if (typeof value !== 'number') continue;
        if (numbers === 0) format = ctl.engine.formatAt(sheet, row, col);
        numbers += 1;
        sum += value;
      }
    }
    if (count < 2) return null;
    if (numbers < 2) return { count, sum: null, average: null };
    const total = Number(sum.toPrecision(15));
    const show = (value: number) => (format && !isDateFormat(format) ? formatValue(value, format) : formatGeneral(Number(value.toPrecision(10))));
    return { count, sum: isDateFormat(format) ? null : show(total), average: show(total / numbers) };
  });

  let message = $derived(ctl.activeMessage);
</script>

<div class="tabs" data-testid="sheet-tabs">
  {#if ctl.canEdit}
    <button type="button" class="add" onclick={() => addSheet(ctl)} title="Add sheet" aria-label="Add sheet" data-testid="sheet-add-tab">
      <span class="i-lucide-plus"></span>
    </button>
  {/if}
  <div class="strip" role="tablist">
    {#each ctl.sheets as sheet, index (sheet.id)}
      {#if dragging && dragging.over === index}<span class="drop"></span>{/if}
      {#if renaming === sheet.id}
        <input
          bind:this={renameInput}
          class="rename"
          bind:value={draft}
          aria-label="Sheet name"
          maxlength="100"
          data-testid="sheet-tab-rename"
          onkeydown={(event) => {
            if (event.key === 'Enter') finishRename(true);
            else if (event.key === 'Escape') finishRename(false);
            event.stopPropagation();
          }}
          onblur={() => finishRename(true)}
        />
      {:else}
        <button
          type="button"
          role="tab"
          class="tab"
          class:active={sheet.id === ctl.sheetId}
          class:dragged={dragging?.id === sheet.id}
          aria-selected={sheet.id === ctl.sheetId}
          data-tab={sheet.id}
          data-testid="sheet-tab"
          onmousedown={event => event.preventDefault()}
          onpointerdown={event => onTabPointerDown(event, sheet.id)}
          onclick={() => { ctl.showSheet(sheet.id); if (!ctl.edit || ctl.edit.source !== 'bar') ctl.focusGrid(); }}
          ondblclick={() => void startRename(sheet.id)}
          oncontextmenu={event => openMenu(event, sheet.id)}
        >
          <span class="name">{sheet.name}</span>
          {#if ctl.canEdit && sheet.id === ctl.sheetId}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <span class="i-lucide-chevron-up caret" title="Sheet options" data-testid="sheet-tab-menu" onclick={(event) => { event.stopPropagation(); openMenu(event, sheet.id); }}></span>
          {/if}
        </button>
      {/if}
    {/each}
    {#if dragging && dragging.over === ctl.sheets.length}<span class="drop"></span>{/if}
  </div>

  <div class="status" role="status" data-testid="sheet-status">
    {#if ctl.notice}
      <span class="notice">{ctl.notice}</span>
    {:else if message}
      <span class="notice">{message}</span>
    {:else if summary}
      {#if summary.sum !== null}<span>Sum <b>{summary.sum}</b></span>{/if}
      {#if summary.average !== null}<span class="wide">Average <b>{summary.average}</b></span>{/if}
      <span class="wide">Count <b>{summary.count}</b></span>
    {/if}
  </div>
</div>

{#if menu}
  <PopupMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => { menu = null; }} />
{/if}

<style>
  .tabs {
    flex: none;
    display: flex;
    align-items: stretch;
    height: 36px;
    border-top: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
    font-size: 0.82rem;
  }

  .add {
    flex: none;
    width: 36px;
    border: none;
    background: transparent;
    color: rgb(var(--text-2));
    font-size: 1rem;
    cursor: pointer;
  }

  .add:hover {
    background: rgb(var(--surface-2));
    color: rgb(var(--text-1));
  }

  .strip {
    display: flex;
    align-items: stretch;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 180px;
    padding: 0 12px;
    border: none;
    border-top: 2px solid transparent;
    background: transparent;
    color: rgb(var(--text-2));
    font-size: inherit;
    cursor: pointer;
    touch-action: pan-x;
  }

  .tab:hover {
    background: rgb(var(--surface-2));
  }

  .tab.active {
    background: rgb(var(--surface-0));
    border-top-color: #916dfe;
    color: rgb(var(--text-1));
    font-weight: 600;
  }

  .tab.dragged {
    opacity: 0.5;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .caret {
    flex: none;
    font-size: 0.8rem;
    color: rgb(var(--text-3));
    border-radius: 4px;
  }

  .caret:hover {
    color: rgb(var(--text-1));
    background: rgb(var(--surface-2));
  }

  .drop {
    flex: none;
    width: 2px;
    margin: 6px -1px;
    background: #916dfe;
  }

  .rename {
    flex: none;
    width: 140px;
    margin: 4px;
    padding: 0 8px;
    border: 1px solid #916dfe;
    border-radius: 4px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: inherit;
    outline: none;
  }

  .status {
    flex: 1 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    max-width: 60%;
    padding: 0 12px;
    color: rgb(var(--text-2));
    white-space: nowrap;
    overflow: hidden;
  }

  .status b {
    color: rgb(var(--text-1));
    font-weight: 600;
  }

  .notice {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 640px) {
    .wide {
      display: none;
    }
  }
</style>
