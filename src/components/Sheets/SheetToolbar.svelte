<script lang="ts">
  /** Formatting controls for the spreadsheet. */
  import {
    adjustDecimals,
    applyBorders,
    applyStyle,
    clearFormatting,
    hasMerges,
    mergeSelection,
    setFontSize,
    toggleStyle,
    unmergeSelection,
  } from '../../lib/sheets/commands';
  import { DEFAULT_POINTS } from '../../lib/sheets/cellText';
  import { columnName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { sortSelection, sortTarget, toggleFilter } from '../../lib/sheets/dataCommands';
  import { NUMBER_FORMATS, TEXT_FORMAT, formatKind } from '../../lib/sheets/format';
  import BorderMenu from './BorderMenu.svelte';
  import ColorMenu from './ColorMenu.svelte';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';
  import { MOD, selectionMenu } from './menus';
  import { insertChart } from '../../lib/sheets/objectCommands';
  import { insertPicture } from '../../lib/sheets/pasting';
  import { openThreadCells } from '../../lib/sheets/comments';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  const FORMAT_CHOICES: Array<{ value: string; label: string; pattern: string | null }> = [
    { value: 'auto', label: 'Automatic', pattern: null },
    { value: 'text', label: 'Plain text', pattern: TEXT_FORMAT },
    { value: 'number', label: 'Number', pattern: NUMBER_FORMATS.number },
    { value: 'percent', label: 'Percent', pattern: NUMBER_FORMATS.percent },
    { value: 'dollar', label: 'Dollar', pattern: NUMBER_FORMATS.dollar },
    { value: 'euro', label: 'Euro', pattern: NUMBER_FORMATS.euro },
    { value: 'pound', label: 'Pound', pattern: NUMBER_FORMATS.pound },
    { value: 'date', label: 'Date', pattern: NUMBER_FORMATS.date },
    { value: 'isoDate', label: 'Date, year first', pattern: NUMBER_FORMATS.isoDate },
    { value: 'time', label: 'Time', pattern: NUMBER_FORMATS.time },
    { value: 'dateTime', label: 'Date and time', pattern: NUMBER_FORMATS.dateTime },
  ];

  let style = $derived(ctl.activeStyle);
  let format = $derived(ctl.activeFormat);
  let formatChoice = $derived.by(() => {
    const kind = formatKind(format);
    if (kind === 'date' && format === NUMBER_FORMATS.isoDate) return 'isoDate';
    if (kind !== 'currency') return kind;
    return format?.includes('€') ? 'euro' : format?.includes('£') ? 'pound' : 'dollar';
  });
  let align = $derived((style.a || '') as '' | 'l' | 'c' | 'r');
  let vertical = $derived((style.va || 'b') as '' | 't' | 'm' | 'b');
  let points = $derived(style.fs ?? DEFAULT_POINTS);
  let merged = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet && hasMerges(ctl);
  });
  const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 36];

  const ALIGN_ICONS = { '': 'i-lucide-align-left', l: 'i-lucide-align-left', c: 'i-lucide-align-center', r: 'i-lucide-align-right' } as const;
  const VERTICAL_ICONS = { '': 'i-lucide-arrow-down-to-line', t: 'i-lucide-arrow-up-to-line', m: 'i-lucide-fold-vertical', b: 'i-lucide-arrow-down-to-line' } as const;

  let colorMenu = $state.raw<{ x: number; y: number; kind: 'c' | 'bg' } | null>(null);
  let borderMenu = $state.raw<{ x: number; y: number } | null>(null);
  let moreMenu = $state.raw<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function keepFocus(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('select')) event.preventDefault();
  }

  function setFormat(event: Event): void {
    const choice = FORMAT_CHOICES.find(option => option.value === (event.target as HTMLSelectElement).value);
    if (choice) applyStyle(ctl, { nf: choice.pattern });
    ctl.focusGrid();
  }

  function openColors(event: MouseEvent, kind: 'c' | 'bg'): void {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    colorMenu = colorMenu?.kind === kind ? null : { x: bounds.left, y: bounds.bottom + 4, kind };
  }

  function openMore(event: MouseEvent): void {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const target = ctl.scope === 'rows' ? 'row' : ctl.scope === 'cols' ? 'col' : 'cell';
    moreMenu = { x: bounds.left, y: bounds.bottom + 4, items: selectionMenu(ctl, target) };
  }

  /** Whether the first row stays on top when sorting, once the person has said so; otherwise it is guessed. */
  let headerChoice: boolean | null = null;

  function openSort(event: MouseEvent | null, fresh: boolean): void {
    if (fresh) headerChoice = null;
    const target = sortTarget(ctl);
    if (!target) {
      ctl.say('There is nothing to sort here.');
      return;
    }
    const bounds = event ? (event.currentTarget as HTMLElement).getBoundingClientRect() : null;
    const place = bounds ? { x: bounds.left, y: bounds.bottom + 4 } : { x: moreMenu?.x ?? 0, y: moreMenu?.y ?? 0 };
    const header = headerChoice ?? target.header;
    const column = columnName(target.keyCol);
    moreMenu = {
      ...place,
      items: [
        { label: `Sort by column ${column}, A to Z`, icon: 'i-lucide-arrow-down-a-z', action: () => sortSelection(ctl, true, header), testId: 'sort-az' },
        { label: `Sort by column ${column}, Z to A`, icon: 'i-lucide-arrow-up-z-a', action: () => sortSelection(ctl, false, header), testId: 'sort-za' },
        {
          label: 'First row is a heading',
          icon: 'i-lucide-square',
          checked: header,
          divider: true,
          testId: 'sort-header',
          action: () => {
            headerChoice = !header;
            // Chosen: show the menu again with the new answer.
            queueMicrotask(() => openSort(null, false));
          },
        },
      ],
    };
  }

  function pickColor(color: string | null): void {
    if (colorMenu) applyStyle(ctl, colorMenu.kind === 'c' ? { c: color } : { bg: color });
  }

  function below(event: MouseEvent): { x: number; y: number } {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: bounds.left, y: bounds.bottom + 4 };
  }

  function openAlign(event: MouseEvent): void {
    const choose = (value: 'l' | 'c' | 'r') => applyStyle(ctl, { a: align === value ? null : value });
    moreMenu = {
      ...below(event),
      items: [
        { label: 'Left', icon: 'i-lucide-align-left', checked: align === 'l', action: () => choose('l'), testId: 'align-left' },
        { label: 'Centre', icon: 'i-lucide-align-center', checked: align === 'c', action: () => choose('c'), testId: 'align-centre' },
        { label: 'Right', icon: 'i-lucide-align-right', checked: align === 'r', action: () => choose('r'), testId: 'align-right' },
        { label: 'Top', icon: VERTICAL_ICONS.t, checked: vertical === 't', divider: true, action: () => applyStyle(ctl, { va: 't' }), testId: 'align-top' },
        { label: 'Middle', icon: VERTICAL_ICONS.m, checked: vertical === 'm', action: () => applyStyle(ctl, { va: 'm' }), testId: 'align-middle' },
        { label: 'Bottom', icon: VERTICAL_ICONS.b, checked: vertical === 'b', action: () => applyStyle(ctl, { va: null }), testId: 'align-bottom' },
      ],
    };
  }

  function openMerge(event: MouseEvent): void {
    const rect = ctl.selection;
    const one = rect.r1 === rect.r2 && rect.c1 === rect.c2;
    moreMenu = {
      ...below(event),
      items: [
        { label: 'Merge all', icon: 'i-lucide-table-cells-merge', action: () => mergeSelection(ctl, 'all'), disabled: one, testId: 'merge-all' },
        { label: 'Merge each row', icon: 'i-lucide-rows-3', action: () => mergeSelection(ctl, 'across'), disabled: rect.c1 === rect.c2, testId: 'merge-across' },
        { label: 'Unmerge', icon: 'i-lucide-table-cells-split', action: () => unmergeSelection(ctl), disabled: !merged, testId: 'merge-none' },
      ],
    };
  }

  let pictureInput: HTMLInputElement | undefined = $state();
  let openComments = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? openThreadCells(ctl.sheet).size : 0;
  });

  function openInsert(event: MouseEvent): void {
    moreMenu = {
      ...below(event),
      items: [
        { label: 'Chart', icon: 'i-lucide-chart-column', action: addChart, testId: 'insert-chart' },
        { label: 'Picture', icon: 'i-lucide-image', action: () => pictureInput?.click(), disabled: !ctl.media, testId: 'insert-picture' },
        { label: 'Checkboxes', icon: 'i-lucide-square-check', divider: true, action: () => { ctl.panel = { kind: 'valid', check: 'checkbox' }; }, testId: 'insert-checkbox' },
        { label: 'List to choose from', icon: 'i-lucide-list', action: () => { ctl.panel = { kind: 'valid', check: 'list' }; }, testId: 'insert-list' },
        { label: 'Data validation', icon: 'i-lucide-list-checks', action: () => { ctl.panel = { kind: 'valid' }; }, testId: 'insert-validation' },
      ],
    };
  }

  function addChart(): void {
    // On a phone the chart goes below the cells, as wide as the screen allows.
    const grid = document.querySelector<HTMLElement>('[data-testid="sheet-grid"]');
    const id = insertChart(ctl, 'column', grid ? grid.clientWidth - 50 : Infinity);
    if (id) ctl.panel = { kind: 'chart', id };
  }

  async function onPictureChosen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    for (const [index, file] of files.entries()) {
      await insertPicture(ctl, file, { row: ctl.active.row, col: ctl.active.col, dx: index * 16, dy: index * 16 });
    }
  }

  function setSize(event: Event): void {
    setFontSize(ctl, Number((event.target as HTMLSelectElement).value));
    ctl.focusGrid();
  }
</script>

<!-- Pressing a button must not take the cursor out of the grid. -->
<div
  class="toolbar shrink-0 border-b border-surface-2 bg-surface-1"
  role="toolbar"
  tabindex="-1"
  aria-label="Formatting"
  data-testid="sheet-toolbar"
  onmousedown={keepFocus}
>
  {#if ctl.canEdit}
  <button onclick={() => ctl.undo()} disabled={!ctl.canUndo} class="tool" title="Undo ({MOD}Z)" aria-label="Undo">
    <span class="i-lucide-undo-2"></span>
  </button>
  <button onclick={() => ctl.redo()} disabled={!ctl.canRedo} class="tool" title="Redo ({MOD}Y)" aria-label="Redo">
    <span class="i-lucide-redo-2"></span>
  </button>

  <span class="divider"></span>

  <select class="format-select" value={formatChoice} onchange={setFormat} aria-label="Number format" title="Number format" data-testid="sheet-number-format">
    {#each FORMAT_CHOICES as choice (choice.value)}
      <option value={choice.value}>{choice.label}</option>
    {/each}
  </select>
  <button onclick={() => adjustDecimals(ctl, -1)} class="tool" title="Fewer decimal places" aria-label="Fewer decimal places">
    <span class="i-lucide-decimals-arrow-left"></span>
  </button>
  <button onclick={() => adjustDecimals(ctl, 1)} class="tool" title="More decimal places" aria-label="More decimal places">
    <span class="i-lucide-decimals-arrow-right"></span>
  </button>

  <select class="size-select" value={points} onchange={setSize} aria-label="Font size" title="Font size" data-testid="sheet-font-size">
    {#each SIZES.includes(points) ? SIZES : [...SIZES, points].sort((a, b) => a - b) as size (size)}
      <option value={size}>{size}</option>
    {/each}
  </select>

  <span class="divider"></span>

  <button onclick={() => toggleStyle(ctl, 'b')} class="tool" class:on={!!style.b} title="Bold ({MOD}B)" aria-label="Bold" aria-pressed={!!style.b}>
    <span class="i-lucide-bold"></span>
  </button>
  <button onclick={() => toggleStyle(ctl, 'i')} class="tool" class:on={!!style.i} title="Italic ({MOD}I)" aria-label="Italic" aria-pressed={!!style.i}>
    <span class="i-lucide-italic"></span>
  </button>
  <button onclick={() => toggleStyle(ctl, 's')} class="tool" class:on={!!style.s} title="Strikethrough" aria-label="Strikethrough" aria-pressed={!!style.s}>
    <span class="i-lucide-strikethrough"></span>
  </button>
  <button onclick={event => openColors(event, 'c')} class="tool color" title="Text colour" aria-label="Text colour" data-testid="sheet-text-color">
    <span class="i-lucide-baseline"></span>
    <span class="chip" style="background: {style.c || 'rgb(var(--text-1))'}"></span>
  </button>
  <button onclick={event => openColors(event, 'bg')} class="tool color" title="Fill colour" aria-label="Fill colour" data-testid="sheet-fill-color">
    <span class="i-lucide-paint-bucket"></span>
    <span class="chip" class:empty={!style.bg} style="background: {style.bg || 'transparent'}"></span>
  </button>

  <button onclick={event => { borderMenu = borderMenu ? null : below(event); }} class="tool" title="Borders" aria-label="Borders" data-testid="sheet-borders">
    <span class="i-lucide-grid-2x2"></span>
  </button>
  <button onclick={openMerge} class="tool" class:on={merged} title="Merge cells" aria-label="Merge cells" data-testid="sheet-merge">
    <span class="i-lucide-table-cells-merge"></span>
  </button>

  <span class="divider"></span>

  <button onclick={openAlign} class="tool pair" title="Alignment" aria-label="Alignment" data-testid="sheet-align">
    <span class={ALIGN_ICONS[align]}></span>
    <span class="small {VERTICAL_ICONS[vertical]}"></span>
  </button>
  <button onclick={() => toggleStyle(ctl, 'w')} class="tool" class:on={!!style.w} title="Wrap text" aria-label="Wrap text" aria-pressed={!!style.w}>
    <span class="i-lucide-wrap-text"></span>
  </button>

  <span class="divider"></span>

  <button onclick={() => clearFormatting(ctl)} class="tool" title="Clear formatting ({MOD}\)" aria-label="Clear formatting">
    <span class="i-lucide-remove-formatting"></span>
  </button>
  <button onclick={openMore} class="tool" title="Rows and columns" aria-label="Rows and columns" data-testid="sheet-rows-columns">
    <span class="i-lucide-table-rows-split"></span>
  </button>
  <button onclick={() => { ctl.panel = ctl.panel?.kind === 'format' ? null : { kind: 'format' }; }} class="tool" class:on={ctl.panel?.kind === 'format'} title="Conditional formatting" aria-label="Conditional formatting" data-testid="sheet-conditional">
    <span class="i-lucide-paint-roller"></span>
  </button>
  <button onclick={openInsert} class="tool" title="Insert" aria-label="Insert" data-testid="sheet-insert">
    <span class="i-lucide-square-plus"></span>
  </button>

  <span class="divider"></span>
  {/if}

  <button onclick={event => openSort(event, true)} class="tool" title="Sort" aria-label="Sort" data-testid="sheet-sort">
    <span class="i-lucide-arrow-down-a-z"></span>
  </button>
  <button onclick={() => toggleFilter(ctl)} class="tool" class:on={ctl.filter !== null} title="Filter" aria-label="Filter" aria-pressed={ctl.filter !== null} data-testid="sheet-filter">
    <span class="i-lucide-list-filter"></span>
  </button>
  <button onclick={() => { ctl.panel = ctl.panel?.kind === 'comments' ? null : { kind: 'comments' }; }} class="tool count" class:on={ctl.panel?.kind === 'comments'} title="Comments" aria-label="Comments" data-testid="sheet-comments">
    <span class="i-lucide-message-square"></span>
    {#if openComments > 0}<span class="badge" data-testid="sheet-comment-count">{openComments}</span>{/if}
  </button>
  <button onclick={() => { if (ctl.find) ctl.find = null; else ctl.openFind(); }} class="tool" class:on={ctl.find !== null} title="Find ({MOD}F)" aria-label="Find" data-testid="sheet-find-button">
    <span class="i-lucide-search"></span>
  </button>
</div>

<input bind:this={pictureInput} type="file" accept="image/*" multiple class="hidden" onchange={onPictureChosen} data-testid="sheet-picture-input" />

{#if colorMenu}
  <ColorMenu
    x={colorMenu.x}
    y={colorMenu.y}
    value={colorMenu.kind === 'c' ? style.c : style.bg}
    noneLabel={colorMenu.kind === 'c' ? 'Default' : 'No fill'}
    onpick={pickColor}
    onclose={() => { colorMenu = null; }}
  />
{/if}

{#if borderMenu}
  <BorderMenu x={borderMenu.x} y={borderMenu.y} onpick={(where, line) => applyBorders(ctl, where, line)} onclose={() => { borderMenu = null; }} />
{/if}

{#if moreMenu}
  <PopupMenu x={moreMenu.x} y={moreMenu.y} items={moreMenu.items} onclose={() => { moreMenu = null; ctl.focusGrid(); }} />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    min-width: 32px;
    height: 32px;
    padding: 0 7px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 1rem;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .tool:hover:not(:disabled) {
    background: rgb(var(--surface-2));
  }

  .tool.on {
    background: rgb(145 109 254 / 0.18);
    color: #916dfe;
  }

  .tool:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .tool.color {
    flex-direction: column;
    gap: 1px;
    font-size: 0.9rem;
  }

  .chip {
    width: 16px;
    height: 3px;
    border-radius: 1px;
  }

  .chip.empty {
    outline: 1px solid rgb(var(--surface-3));
  }

  .divider {
    flex: none;
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background: rgb(var(--surface-3));
  }

  .format-select {
    flex: none;
    width: 108px;
    height: 32px;
    padding: 0 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    cursor: pointer;
    text-overflow: ellipsis;
  }

  .format-select:hover,
  .size-select:hover {
    background: rgb(var(--surface-2));
  }

  .size-select {
    flex: none;
    width: 52px;
    height: 32px;
    padding: 0 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    cursor: pointer;
  }

  .tool.count {
    position: relative;
  }

  .badge {
    position: absolute;
    top: 2px;
    right: 1px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 8px;
    background: #f59f00;
    color: #1a1a1a;
    font-size: 0.65rem;
    font-weight: 700;
    line-height: 15px;
  }

  .tool.pair {
    gap: 1px;
    padding: 0 5px;
  }

  .small {
    font-size: 0.8rem;
    color: rgb(var(--text-2));
  }

  /* Room for a finger. */
  @media (pointer: coarse) {
    .tool {
      min-width: 40px;
      height: 40px;
    }

    .format-select,
    .size-select {
      height: 40px;
    }
  }
</style>
