<script lang="ts">
  /** The menus of tables: the size of a new one, its rows and columns, and the fill of its cells. */
  import type { Palette } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import { activeCell, addTableLine, fillCells, removeTableLine } from '../../lib/slides/tableEditing';
  import Popover from './Popover.svelte';
  import ColourPanel from './ColourPanel.svelte';

  interface Props {
    editorState: SlidesEditorState;
    palette: Palette;
    anchors: { table?: HTMLElement; lines?: HTMLElement; fill?: HTMLElement };
    insertOpen: boolean;
    linesOpen: boolean;
    fillOpen: boolean;
    /** Closes these and every other menu of the toolbar. */
    onDone: () => void;
  }
  let { editorState, palette, anchors, insertOpen = $bindable(), linesOpen = $bindable(), fillOpen = $bindable(), onDone }: Props = $props();

  let table = $derived(editorState.selectedTable);
  let cell = $derived(table ? activeCell(editorState) : null);
  let cellChosen = $derived(!!cell);
  let cellFill = $derived(cell?.fill);

  function pick(action: () => void): void {
    onDone();
    action();
  }

  // The size picked for a new table, as the pointer or arrow keys move over the grid.
  const GRID_ROWS = 8;
  const GRID_COLS = 10;
  let gridSize = $state({ rows: 3, cols: 3 });

  function gridKey(event: KeyboardEvent): void {
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    gridSize = {
      rows: Math.min(GRID_ROWS, Math.max(1, gridSize.rows + move[0])),
      cols: Math.min(GRID_COLS, Math.max(1, gridSize.cols + move[1])),
    };
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-size="${gridSize.rows}x${gridSize.cols}"]`)?.focus();
  }
</script>

<Popover bind:open={insertOpen} anchor={anchors.table} label="Table">
  <div class="menu-label" data-testid="table-size">{gridSize.rows} × {gridSize.cols}</div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="grid-pick" style:grid-template-columns="repeat({GRID_COLS}, 18px)" onkeydown={gridKey}>
    {#each Array.from({ length: GRID_ROWS }, (_, row) => row + 1) as row (row)}
      {#each Array.from({ length: GRID_COLS }, (_, col) => col + 1) as col (col)}
        <button
          class="grid-cell"
          class:on={row <= gridSize.rows && col <= gridSize.cols}
          data-size="{row}x{col}"
          aria-label="{row} by {col} table"
          tabindex={row === gridSize.rows && col === gridSize.cols ? 0 : -1}
          onpointerenter={() => (gridSize = { rows: row, cols: col })}
          onfocus={() => (gridSize = { rows: row, cols: col })}
          onclick={() => pick(() => editorState.addTable(row, col))}
          data-testid="table-{row}x{col}"
        ></button>
      {/each}
    {/each}
  </div>
</Popover>

<Popover bind:open={linesOpen} anchor={anchors.lines} label="Rows and columns">
  <button class="menu-item" onclick={() => pick(() => addTableLine(editorState, 'row', 'before'))} data-testid="table-row-above"><span class="i-lucide-between-horizontal-start"></span>Insert row above</button>
  <button class="menu-item" onclick={() => pick(() => addTableLine(editorState, 'row', 'after'))} data-testid="table-row-below"><span class="i-lucide-between-horizontal-end"></span>Insert row below</button>
  <button class="menu-item" onclick={() => pick(() => addTableLine(editorState, 'column', 'before'))} data-testid="table-column-left"><span class="i-lucide-between-vertical-start"></span>Insert column left</button>
  <button class="menu-item" onclick={() => pick(() => addTableLine(editorState, 'column', 'after'))} data-testid="table-column-right"><span class="i-lucide-between-vertical-end"></span>Insert column right</button>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => pick(() => removeTableLine(editorState, 'row'))} data-testid="table-row-delete"><span class="i-lucide-trash-2"></span>Delete row</button>
  <button class="menu-item" onclick={() => pick(() => removeTableLine(editorState, 'column'))} data-testid="table-column-delete"><span class="i-lucide-trash-2"></span>Delete column</button>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => pick(() => editorState.updateSelected({ header: table?.header ? undefined : true }))} data-testid="table-header">
    <span class="i-lucide-panel-top"></span>Heading row
    {#if table?.header}<span class="i-lucide-check ml-auto"></span>{/if}
  </button>
  {#if !cellChosen}
    <div class="menu-label">Rows and columns are added at the end until a cell is clicked.</div>
  {/if}
</Popover>

<Popover bind:open={fillOpen} anchor={anchors.fill} label="Cell fill">
  <div class="menu-label">{cellChosen ? 'This cell' : 'Every cell'}</div>
  <ColourPanel value={cellFill} {palette} themeChoice="As the table" allowNone onPick={colour => pick(() => fillCells(editorState, colour))} />
</Popover>

<style>
  .grid-pick {
    display: grid;
    gap: 3px;
    padding: 2px 8px 8px;
  }

  .grid-cell {
    width: 18px;
    height: 18px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 3px;
    background: rgb(var(--surface-0));
  }

  .grid-cell.on {
    border-color: #916dfe;
    background: rgb(145 109 254 / 0.25);
  }

  .grid-cell:focus-visible {
    outline: 2px solid #916dfe;
    outline-offset: 1px;
  }
</style>
