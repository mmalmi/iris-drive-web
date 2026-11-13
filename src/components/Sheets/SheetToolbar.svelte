<script lang="ts">
  /** Formatting controls for the spreadsheet. */
  import { adjustDecimals, applyStyle, clearFormatting, toggleStyle } from '../../lib/sheets/commands';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { NUMBER_FORMATS, TEXT_FORMAT, formatKind } from '../../lib/sheets/format';
  import ColorMenu from './ColorMenu.svelte';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';
  import { MOD, selectionMenu } from './menus';

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
    { value: 'time', label: 'Time', pattern: NUMBER_FORMATS.time },
    { value: 'dateTime', label: 'Date and time', pattern: NUMBER_FORMATS.dateTime },
  ];

  let style = $derived(ctl.activeStyle);
  let format = $derived(ctl.activeFormat);
  let formatChoice = $derived.by(() => {
    const kind = formatKind(format);
    if (kind !== 'currency') return kind;
    return format?.includes('€') ? 'euro' : format?.includes('£') ? 'pound' : 'dollar';
  });
  let align = $derived(style.a || '');

  let colorMenu = $state.raw<{ x: number; y: number; kind: 'c' | 'bg' } | null>(null);
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

  function pickColor(color: string | null): void {
    if (colorMenu) applyStyle(ctl, colorMenu.kind === 'c' ? { c: color } : { bg: color });
  }

  function setAlign(value: 'l' | 'c' | 'r'): void {
    applyStyle(ctl, { a: align === value ? null : value });
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

  <span class="divider"></span>

  <button onclick={() => setAlign('l')} class="tool" class:on={align === 'l'} title="Align left" aria-label="Align left" aria-pressed={align === 'l'}>
    <span class="i-lucide-align-left"></span>
  </button>
  <button onclick={() => setAlign('c')} class="tool" class:on={align === 'c'} title="Align centre" aria-label="Align centre" aria-pressed={align === 'c'}>
    <span class="i-lucide-align-center"></span>
  </button>
  <button onclick={() => setAlign('r')} class="tool" class:on={align === 'r'} title="Align right" aria-label="Align right" aria-pressed={align === 'r'}>
    <span class="i-lucide-align-right"></span>
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
</div>

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

  .format-select:hover {
    background: rgb(var(--surface-2));
  }
</style>
