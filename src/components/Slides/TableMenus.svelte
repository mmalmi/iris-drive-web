<script lang="ts" module>
  /** The line last chosen for cell edges, kept while the app is open. */
  let lastColour = 'text';
  let lastWidth = 2;
</script>

<script lang="ts">
  /** The menus of tables: the size of a new one, its rows and columns, merging, the fill of its cells and their lines. */
  import type { Palette } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import type { BorderChoice } from '../../lib/slides/table';
  import { addTableLine, cellChoice, fillCells, mergePicked, removeTableLine, setBorders, unmergePicked } from '../../lib/slides/tableEditing';
  import Popover from './Popover.svelte';
  import ColourPanel from './ColourPanel.svelte';

  interface Props {
    editorState: SlidesEditorState;
    palette: Palette;
    anchors: { table?: HTMLElement; lines?: HTMLElement; fill?: HTMLElement; borders?: HTMLElement };
    insertOpen: boolean;
    linesOpen: boolean;
    fillOpen: boolean;
    bordersOpen: boolean;
    /** Closes these and every other menu of the toolbar. */
    onDone: () => void;
  }
  let { editorState, palette, anchors, insertOpen = $bindable(), linesOpen = $bindable(), fillOpen = $bindable(), bordersOpen = $bindable(), onDone }: Props = $props();

  let table = $derived(editorState.selectedTable);
  let choice = $derived(cellChoice(editorState));
  let cellFill = $derived.by(() => {
    const element = table;
    const key = element ? (editorState.editingId === element.id ? editorState.editingCell : null) ?? editorState.tableCell : null;
    return key ? element?.table?.cells.get(key)?.fill : undefined;
  });
  let scopeLabel = $derived(choice.scope === 'picked' ? 'The picked cells' : choice.scope === 'cell' ? 'This cell' : 'Every cell');

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

  // Lines of cells: where they go, and the colour and thickness they are drawn in.
  type Place = BorderChoice | 'none' | 'reset';
  const PLACES: Array<{ place: Place; label: string; paths: string[] }> = [
    { place: 'all', label: 'All lines', paths: ['M3 3H21V21H3Z', 'M3 12H21', 'M12 3V21'] },
    { place: 'inner', label: 'Inner lines', paths: ['M3 12H21', 'M12 3V21'] },
    { place: 'outer', label: 'Outer lines', paths: ['M3 3H21V21H3Z'] },
    { place: 'top', label: 'Top line', paths: ['M3 3H21'] },
    { place: 'bottom', label: 'Bottom line', paths: ['M3 21H21'] },
    { place: 'left', label: 'Left line', paths: ['M3 3V21'] },
    { place: 'right', label: 'Right line', paths: ['M21 3V21'] },
    { place: 'none', label: 'No lines', paths: [] },
  ];
  const WIDTHS = [1, 2, 4, 6];
  let colour = $state(lastColour);
  let width = $state(lastWidth);
  /** The place chosen last while the menu is open: a new colour or thickness goes there too. */
  let placed = $state<Place | null>(null);

  $effect(() => {
    if (!bordersOpen) placed = null;
  });

  function applyPlace(place: Place): void {
    placed = place;
    const element = table;
    if (!element) return;
    // For a whole table with no cell picked, all or no lines are the table's own, so rows added later get them too.
    if (choice.scope === 'all' && (place === 'all' || place === 'none' || place === 'reset')) {
      editorState.step(() => editorState.deck.transact(() => {
        setBorders(editorState, 'all', null);
        if (place !== 'reset') editorState.updateSelected(place === 'none' ? { stroke: 'none' } : { stroke: colour, strokeWidth: width });
        else editorState.updateSelected({ stroke: undefined, strokeWidth: undefined });
      }));
      return;
    }
    if (place === 'reset') setBorders(editorState, 'all', null);
    else if (place === 'none') setBorders(editorState, 'all', 'none');
    else setBorders(editorState, place, { width, colour });
  }

  function setPen(next: { colour?: string; width?: number }): void {
    if (next.colour) colour = lastColour = next.colour;
    if (next.width) width = lastWidth = next.width;
    if (placed && placed !== 'none' && placed !== 'reset') applyPlace(placed);
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
  <button class="menu-item" disabled={!choice.canMerge} onclick={() => pick(() => mergePicked(editorState))} data-testid="table-merge"><span class="i-lucide-table-cells-merge"></span>Merge cells</button>
  <button class="menu-item" disabled={!choice.canUnmerge} onclick={() => pick(() => unmergePicked(editorState))} data-testid="table-unmerge"><span class="i-lucide-table-cells-split"></span>Unmerge cells</button>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => pick(() => editorState.updateSelected({ header: table?.header ? undefined : true }))} data-testid="table-header">
    <span class="i-lucide-panel-top"></span>Heading row
    {#if table?.header}<span class="i-lucide-check ml-auto"></span>{/if}
  </button>
  {#if choice.scope === 'all'}
    <div class="menu-label hint">Click a cell first to add beside it; drag across cells to merge them.</div>
  {:else if !choice.canMerge && choice.scope === 'cell'}
    <div class="menu-label hint">Drag across cells, or Shift and click, to merge them.</div>
  {/if}
</Popover>

<Popover bind:open={fillOpen} anchor={anchors.fill} label="Cell fill">
  <div class="menu-label">{scopeLabel}</div>
  <ColourPanel value={choice.scope === 'cell' ? cellFill : undefined} {palette} themeChoice="As the table" allowNone onPick={value => pick(() => fillCells(editorState, value))} />
</Popover>

<Popover bind:open={bordersOpen} anchor={anchors.borders} label="Cell lines">
  <div class="menu-label">{scopeLabel}</div>
  <div class="places" role="group" aria-label="Where">
    {#each PLACES as item (item.place)}
      <button class="place" class:on={placed === item.place} title={item.label} aria-label={item.label} onclick={() => applyPlace(item.place)} data-testid="cell-lines-{item.place}">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M3 3H21V21H3Z M3 12H21 M12 3V21" class="faint" />
          {#each item.paths as path (path)}<path d={path} />{/each}
        </svg>
      </button>
    {/each}
    <button class="place" class:on={placed === 'reset'} title="As the table" aria-label="As the table" onclick={() => applyPlace('reset')} data-testid="cell-lines-reset">
      <span class="i-lucide-rotate-ccw"></span>
    </button>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-label">Thickness</div>
  <div class="places">
    {#each WIDTHS as each (each)}
      <button class="place" class:on={width === each} title={String(each)} aria-label="Thickness {each}" onclick={() => setPen({ width: each })}>
        <span class="sample" style:height="{each}px"></span>
      </button>
    {/each}
  </div>
  <div class="menu-divider"></div>
  <ColourPanel value={colour} {palette} onPick={value => setPen({ colour: value ?? 'text' })} />
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

  .hint {
    max-width: 230px;
    white-space: normal;
  }

  .places {
    display: grid;
    grid-template-columns: repeat(5, 34px);
    gap: 2px;
    padding: 2px 8px 6px;
  }

  .place {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 32px;
    border-radius: 6px;
    color: rgb(var(--text-1));
  }

  .place:hover,
  .place:focus-visible {
    background: rgb(var(--surface-2));
    outline: none;
  }

  .place.on {
    background: rgb(145 109 254 / 0.18);
    color: #916dfe;
  }

  .place svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: square;
  }

  .place svg .faint {
    stroke-width: 1;
    stroke-dasharray: 2 2;
    opacity: 0.45;
  }

  .sample {
    display: block;
    width: 20px;
    border-radius: 1px;
    background: currentColor;
  }
</style>
