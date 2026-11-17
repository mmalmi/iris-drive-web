<script lang="ts">
  /** The buttons above the slide. Those for text, shapes and lines show only while such a thing is selected. */
  import type { ShapeKind } from '../../lib/slides/model';
  import { resolveColour, textStyle } from '../../lib/slides/themes';
  import { FONT_SIZES } from '../../lib/slides/richText';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import Popover from './Popover.svelte';
  import ColourPanel from './ColourPanel.svelte';
  import { activeCell } from '../../lib/slides/tableEditing';

  interface Props {
    editorState: SlidesEditorState;
    onPickImage: () => void;
    /** Opens the field for a link's address, for the words chosen. */
    onLink?: () => void;
  }
  let { editorState, onPickImage, onLink }: Props = $props();

  type MenuName = 'layout' | 'shape' | 'size' | 'colour' | 'align' | 'fill' | 'border' | 'arrange' | 'relayout' | 'background' | 'theme' | 'motion'
    | 'table' | 'tableEdit' | 'cellFill' | 'cellLines' | 'slideMore';
  let open = $state<Record<MenuName, boolean>>({
    layout: false, shape: false, size: false, colour: false, align: false, fill: false, border: false, arrange: false, relayout: false, background: false, theme: false, motion: false,
    table: false, tableEdit: false, cellFill: false, cellLines: false, slideMore: false,
  });
  /** Where the menus of the slide open when they were chosen from the one button that stands for them on a crowded row. */
  let compactAnchor = $state<HTMLElement | null>(null);

  function openSlideMenu(name: 'relayout' | 'background' | 'motion' | 'theme', from: HTMLElement | null): void {
    const wasOpen = open[name];
    close();
    compactAnchor = from;
    open[name] = !wasOpen;
  }
  let anchors = $state<Partial<Record<MenuName, HTMLElement>>>({});

  let palette = $derived(editorState.palette);
  let selected = $derived(editorState.selected);
  let textBoxes = $derived(editorState.selectedText);
  let shapes = $derived(selected.filter(element => element.type === 'shape'));
  let lines = $derived(selected.filter(element => element.type === 'line'));
  let table = $derived(editorState.selectedTable);
  let outlined = $derived([...shapes, ...lines, ...(table ? [table] : [])]);
  let boxed = $derived(shapes.length > 0 || !!table);
  let firstText = $derived(editorState.editing ?? textBoxes[0]);
  let style = $derived(firstText ? textStyle(firstText, editorState.theme, editorState.current?.layout ?? 'blank') : null);
  let fontSize = $derived(editorState.fontSize);
  let align = $derived(editorState.align);
  let tool = $derived(editorState.tool);
  /** With no slide there is nothing to put things on. */
  let noSlide = $derived(!editorState.current);
  let textColour = $derived(editorState.textColour);
  let shownTextColour = $derived(resolveColour(textColour, palette) ?? style?.color ?? palette.text);
  let fill = $derived(shapes[0] ? resolveColour(shapes[0].fill, palette, palette.accent) : null);
  let stroke = $derived(outlined[0] ? resolveColour(outlined[0].stroke, palette, outlined[0].type === 'line' ? palette.text : outlined[0].type === 'table' ? palette.muted : null) : null);
  let cellFill = $derived(table ? activeCell(editorState)?.fill : undefined);
  let cellChosen = $derived(!!table && (!!activeCell(editorState) || !!editorState.pickedCells));

  const SHAPES: Array<{ shape: ShapeKind; label: string; icon: string }> = [
    { shape: 'rect', label: 'Rectangle', icon: 'i-lucide-square' },
    { shape: 'round', label: 'Rounded rectangle', icon: 'i-lucide-squircle' },
    { shape: 'ellipse', label: 'Ellipse', icon: 'i-lucide-circle' },
  ];
  const WIDTHS = [1, 2, 4, 8, 12];

  function keepFocus(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('input, select')) event.preventDefault();
  }

  // The menus for whole slides and for tables are loaded apart, as they are first needed; once the deck is idle, ahead of time.
  const loadSlideMenus = () => import('./SlideMenus.svelte');
  const loadTableMenus = () => import('./TableMenus.svelte');
  $effect(() => {
    const early = setTimeout(() => {
      void loadSlideMenus();
      void loadTableMenus();
    }, 2000);
    return () => clearTimeout(early);
  });

  function close(): void {
    for (const name of Object.keys(open) as MenuName[]) open[name] = false;
    sheetOpen = false;
  }

  /** On a phone the row holds what is used most and the rest is in a sheet. */
  const narrowScreen = window.matchMedia('(max-width: 639px)');
  let narrow = $state(narrowScreen.matches);
  let sheetOpen = $state(false);
  let sheetButton: HTMLElement | undefined = $state();
  $effect(() => {
    const onChange = () => (narrow = narrowScreen.matches);
    narrowScreen.addEventListener('change', onChange);
    return () => narrowScreen.removeEventListener('change', onChange);
  });

  function pick(action: () => void): void {
    close();
    action();
  }

  function stepFontSize(direction: -1 | 1): void {
    if (fontSize === null) return;
    const next = direction > 0
      ? FONT_SIZES.find(size => size > fontSize!) ?? fontSize + 8
      : [...FONT_SIZES].reverse().find(size => size < fontSize!) ?? fontSize - 1;
    editorState.setFontSize(next);
  }

  // On a narrow screen the row scrolls; its ends fade where there is more to see.
  let bar: HTMLElement | undefined = $state();
  let moreBefore = $state(false);
  let moreAfter = $state(false);

  /** Whether the slide's four buttons are folded into one, because the row has no room for them. */
  let folded = $state(false);
  /** How wide the four were when last shown. */
  let unfoldedWidth = 0;

  function measureOverflow(): void {
    if (!bar) return;
    moreBefore = bar.scrollLeft > 1;
    moreAfter = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
    if (narrow) return;
    const wide = [...bar.querySelectorAll<HTMLElement>('.slide-wide > *')].reduce((sum, button) => sum + button.offsetWidth + 2, 0);
    if (!folded) {
      if (wide > 0) unfoldedWidth = wide;
      if (bar.scrollWidth > bar.clientWidth + 1) folded = true;
      return;
    }
    // Unfolded again once the room left over would hold the four, with a little to spare.
    const spare = (bar.querySelector<HTMLElement>(':scope > .spacer')?.offsetWidth ?? 0) - 8;
    const compact = bar.querySelector<HTMLElement>('.slide-compact')?.offsetWidth ?? 0;
    if (unfoldedWidth > 0 && spare >= unfoldedWidth - compact + 12) folded = false;
  }

  $effect(() => {
    const row = bar;
    if (!row) return;
    const resized = new ResizeObserver(measureOverflow);
    resized.observe(row);
    // Buttons come and go with what is selected.
    const changed = new MutationObserver(measureOverflow);
    changed.observe(row, { childList: true, subtree: true });
    measureOverflow();
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  });

  function typedFontSize(event: Event): void {
    const value = Number.parseInt((event.target as HTMLInputElement).value, 10);
    if (Number.isFinite(value)) editorState.setFontSize(value);
  }
</script>

<!-- Pressing a button must not take the cursor out of the text. -->
<div class="shell">
<div
  class="toolbar"
  class:busy={selected.length > 0 || !!firstText}
  class:more-before={moreBefore}
  class:more-after={moreAfter}
  class:folded
  bind:this={bar}
  role="toolbar"
  tabindex="-1"
  aria-label="Editing"
  data-testid="slides-toolbar"
  onmousedown={keepFocus}
  onscroll={measureOverflow}
>
  <button class="tool" onclick={() => editorState.undo()} disabled={!editorState.canUndo} title="Undo" aria-label="Undo">
    <span class="i-lucide-undo-2"></span>
  </button>
  <button class="tool" onclick={() => editorState.redo()} disabled={!editorState.canRedo} title="Redo" aria-label="Redo">
    <span class="i-lucide-redo-2"></span>
  </button>

  <span class="divider"></span>

  {#if narrow}
    <!-- One button on a phone: it offers the layouts, and a tap on one adds the slide. -->
    <button class="tool" bind:this={anchors.layout} onclick={() => (open.layout = !open.layout)} title="New slide" aria-label="New slide" aria-expanded={open.layout} data-testid="new-slide-layout">
      <span class="i-lucide-plus"></span>
    </button>
  {:else}
    <div class="split">
      <button class="tool labelled" onclick={() => editorState.addSlide()} title="New slide" data-testid="new-slide">
        <span class="i-lucide-plus"></span><span class="label">Slide</span>
      </button>
      <button class="tool caret" bind:this={anchors.layout} onclick={() => (open.layout = !open.layout)} title="Choose a layout" aria-label="Choose a layout" aria-expanded={open.layout} data-testid="new-slide-layout">
        <span class="i-lucide-chevron-down"></span>
      </button>
    </div>
  {/if}

  <span class="divider"></span>

  <!-- These pick up a tool: the next click or drag on the slide makes the thing there. -->
  <button class="tool" class:on={tool?.kind === 'text'} onclick={() => editorState.armTool({ kind: 'text' })} disabled={noSlide} title="Text box: click or drag on the slide" aria-label="Text box" aria-pressed={tool?.kind === 'text'} data-testid="add-text">
    <span class="i-lucide-type"></span>
  </button>
  <button class="tool" class:on={tool?.kind === 'shape' || tool?.kind === 'line'} bind:this={anchors.shape} onclick={() => (open.shape = !open.shape)} disabled={noSlide} title="Shape: click or drag on the slide" aria-label="Shape" aria-expanded={open.shape} data-testid="add-shape">
    <span class="i-lucide-shapes"></span>
  </button>
  <button class="tool" onclick={onPickImage} disabled={noSlide} title="Image" aria-label="Image" data-testid="add-image">
    <span class="i-lucide-image"></span>
  </button>
  {#if !narrow}
    <button class="tool" bind:this={anchors.table} onclick={() => (open.table = !open.table)} disabled={noSlide} title="Table" aria-label="Table" aria-expanded={open.table} data-testid="add-table">
      <span class="i-lucide-table"></span>
    </button>
  {/if}

  {#if narrow}
    <!-- On a phone the row keeps what is used most; the rest is one tap away, in a sheet. -->
    {#if editorState.editingId && firstText}
      <span class="divider"></span>
      <button class="tool" class:on={editorState.markActive('bold')} onclick={() => editorState.toggleMark('bold')} title="Bold" aria-label="Bold" aria-pressed={editorState.markActive('bold')}>
        <span class="i-lucide-bold"></span>
      </button>
      <button class="tool" class:on={editorState.listActive('bulletList')} onclick={() => editorState.toggleList('bulletList')} title="Bulleted list" aria-label="Bulleted list" aria-pressed={editorState.listActive('bulletList')}>
        <span class="i-lucide-list"></span>
      </button>
    {:else if selected.length > 0}
      <span class="divider"></span>
      <button class="tool" onclick={() => editorState.deleteSelected()} title="Delete" aria-label="Delete selection" data-testid="delete-selection">
        <span class="i-lucide-trash-2"></span>
      </button>
    {/if}
    <span class="spacer"></span>
    <button class="tool" class:on={sheetOpen} bind:this={sheetButton} onclick={() => (sheetOpen = !sheetOpen)} title="More tools" aria-label="More tools" aria-expanded={sheetOpen} data-testid="toolbar-more">
      <span class="i-lucide-sliders-horizontal"></span>
    </button>
  {:else}
    {@render formatting()}
    {@render slideTools()}
  {/if}
</div>
</div>

<Popover bind:open={sheetOpen} anchor={sheetButton} label="Tools" sheet>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="sheet-body" onmousedown={keepFocus} data-testid="toolbar-sheet">
    {#if firstText && fontSize !== null}
      <div class="menu-label">Text</div>
      <div class="sheet-row">{@render textTools()}</div>
    {/if}
    {#if outlined.length > 0}
      <div class="menu-label">{table ? 'Table' : shapes.length ? 'Shape' : 'Line'}</div>
      <div class="sheet-row">{@render shapeTools()}</div>
    {/if}
    {#if selected.length > 0}
      <div class="menu-label">Selection</div>
      <div class="sheet-row">{@render selectionTools()}</div>
    {/if}
    <div class="menu-label">Slide</div>
    <div class="sheet-row">
      <button class="tool labelled" bind:this={anchors.table} onclick={() => (open.table = !open.table)} disabled={noSlide} aria-expanded={open.table} data-testid="add-table">
        <span class="i-lucide-table"></span><span class="label">Table</span>
      </button>
      {@render slideTools()}
    </div>
  </div>
</Popover>

{#snippet formatting()}
  {#if firstText && fontSize !== null}
    <span class="divider"></span>
    {@render textTools()}
  {/if}

  {#if outlined.length > 0}
    <span class="divider"></span>
    {@render shapeTools()}
  {/if}

  {#if selected.length > 0}
    <span class="divider"></span>
    {@render selectionTools()}
  {/if}

  <span class="spacer"></span>
{/snippet}

{#snippet textTools()}
    <div class="size" data-testid="font-size">
      <button class="tool narrow" onclick={() => stepFontSize(-1)} title="Smaller" aria-label="Smaller text">
        <span class="i-lucide-minus"></span>
      </button>
      <input
        class="size-input"
        bind:this={anchors.size}
        type="text"
        inputmode="numeric"
        value={fontSize}
        aria-label="Text size"
        onfocus={event => (event.target as HTMLInputElement).select()}
        onchange={typedFontSize}
        onkeydown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          event.stopPropagation();
        }}
        data-testid="font-size-input"
      />
      <button class="tool narrow" onclick={() => stepFontSize(1)} title="Larger" aria-label="Larger text">
        <span class="i-lucide-plus"></span>
      </button>
    </div>
    <button class="tool" class:on={editorState.markActive('bold')} onclick={() => editorState.toggleMark('bold')} title="Bold" aria-label="Bold" aria-pressed={editorState.markActive('bold')}>
      <span class="i-lucide-bold"></span>
    </button>
    <button class="tool" class:on={editorState.markActive('italic')} onclick={() => editorState.toggleMark('italic')} title="Italic" aria-label="Italic" aria-pressed={editorState.markActive('italic')}>
      <span class="i-lucide-italic"></span>
    </button>
    <button class="tool" class:on={editorState.markActive('underline')} onclick={() => editorState.toggleMark('underline')} title="Underline" aria-label="Underline" aria-pressed={editorState.markActive('underline')}>
      <span class="i-lucide-underline"></span>
    </button>
    <button class="tool" bind:this={anchors.colour} onclick={() => (open.colour = !open.colour)} title="Text colour" aria-label="Text colour" aria-expanded={open.colour} data-testid="text-colour">
      <span class="ink"><span class="i-lucide-baseline"></span><span class="ink-bar" style:background={shownTextColour}></span></span>
    </button>
    <button class="tool" bind:this={anchors.align} onclick={() => (open.align = !open.align)} title="Align" aria-label="Align" aria-expanded={open.align} data-testid="text-align">
      <span class={align === 'center' ? 'i-lucide-align-center' : align === 'right' ? 'i-lucide-align-right' : 'i-lucide-align-left'}></span>
    </button>
    <button class="tool" class:on={editorState.listActive('bulletList')} onclick={() => editorState.toggleList('bulletList')} title="Bulleted list" aria-label="Bulleted list" aria-pressed={editorState.listActive('bulletList')}>
      <span class="i-lucide-list"></span>
    </button>
    <button class="tool" class:on={editorState.listActive('orderedList')} onclick={() => editorState.toggleList('orderedList')} title="Numbered list" aria-label="Numbered list" aria-pressed={editorState.listActive('orderedList')}>
      <span class="i-lucide-list-ordered"></span>
    </button>
    {#if editorState.editingId && onLink}
      <button class="tool" onclick={onLink} title="Link" aria-label="Link" data-testid="text-link">
        <span class="i-lucide-link"></span>
      </button>
    {/if}
{/snippet}

{#snippet shapeTools()}
    {#if shapes.length > 0}
      <button class="tool" bind:this={anchors.fill} onclick={() => (open.fill = !open.fill)} title="Fill" aria-label="Fill" aria-expanded={open.fill} data-testid="shape-fill">
        <span class="ink"><span class="i-lucide-paint-bucket"></span><span class="ink-bar" class:ink-none={!fill} style:background={fill ?? undefined}></span></span>{#if narrow}<span class="label">Fill</span>{/if}
      </button>
    {/if}
    {#if table}
      <button class="tool" bind:this={anchors.tableEdit} onclick={() => (open.tableEdit = !open.tableEdit)} title="Rows and columns" aria-label="Rows and columns" aria-expanded={open.tableEdit} data-testid="table-lines">
        <span class="i-lucide-table-properties"></span>{#if narrow}<span class="label">Rows and columns</span>{/if}
      </button>
      <button class="tool" bind:this={anchors.cellFill} onclick={() => (open.cellFill = !open.cellFill)} title={cellChosen ? 'Cell fill' : 'Fill for every cell'} aria-label="Cell fill" aria-expanded={open.cellFill} data-testid="cell-fill">
        <span class="ink"><span class="i-lucide-paint-bucket"></span><span class="ink-bar" class:ink-none={!cellFill} style:background={resolveColour(cellFill, palette) ?? undefined}></span></span>{#if narrow}<span class="label">Cell fill</span>{/if}
      </button>
    {/if}
    {#if table}
      <button class="tool" bind:this={anchors.cellLines} onclick={() => (open.cellLines = !open.cellLines)} title="Cell lines" aria-label="Cell lines" aria-expanded={open.cellLines} data-testid="shape-border">
        <span class="ink"><span class="i-lucide-grid-3x3"></span><span class="ink-bar" class:ink-none={!stroke} style:background={stroke ?? undefined}></span></span>{#if narrow}<span class="label">Lines</span>{/if}
      </button>
    {:else}
      <button class="tool" bind:this={anchors.border} onclick={() => (open.border = !open.border)} title={boxed ? 'Border' : 'Line'} aria-label={boxed ? 'Border' : 'Line'} aria-expanded={open.border} data-testid="shape-border">
        <span class="ink"><span class="i-lucide-pen-line"></span><span class="ink-bar" class:ink-none={!stroke} style:background={stroke ?? undefined}></span></span>{#if narrow}<span class="label">{boxed ? 'Border' : 'Line'}</span>{/if}
      </button>
    {/if}
{/snippet}

{#snippet selectionTools()}
  {#if narrow}
    <button class="tool labelled" bind:this={anchors.arrange} onclick={() => (open.arrange = !open.arrange)} aria-expanded={open.arrange} data-testid="arrange">
      <span class="i-lucide-layers"></span><span class="label">Arrange</span>
    </button>
    <button class="tool labelled" onclick={() => pick(() => editorState.duplicateSelected())}>
      <span class="i-lucide-copy"></span><span class="label">Duplicate</span>
    </button>
    <button class="tool labelled" onclick={() => pick(() => editorState.deleteSelected())}>
      <span class="i-lucide-trash-2"></span><span class="label">Delete</span>
    </button>
  {:else}
    <button class="tool" bind:this={anchors.arrange} onclick={() => (open.arrange = !open.arrange)} title="Arrange" aria-label="Arrange" aria-expanded={open.arrange} data-testid="arrange">
      <span class="i-lucide-layers"></span>
    </button>
    <button class="tool" onclick={() => editorState.deleteSelected()} title="Delete" aria-label="Delete selection" data-testid="delete-selection">
      <span class="i-lucide-trash-2"></span>
    </button>
  {/if}
{/snippet}

{#snippet slideTools()}
  <!-- On a row crowded with what can be done to a selection, these four fold into one button. -->
  <span class="slide-wide">
    <button class="tool labelled" bind:this={anchors.relayout} onclick={() => openSlideMenu('relayout', null)} disabled={noSlide} title="Slide layout" aria-label="Slide layout" aria-expanded={open.relayout} data-testid="slide-layout">
      <span class="i-lucide-layout-template"></span><span class="label roomy">Layout</span>
    </button>
    <button class="tool labelled" bind:this={anchors.background} onclick={() => openSlideMenu('background', null)} disabled={noSlide} title="Slide background" aria-label="Slide background" aria-expanded={open.background} data-testid="slide-background">
      <span class="i-lucide-paint-roller"></span><span class="label roomy">Background</span>
    </button>
    <button class="tool labelled" class:on={!!(editorState.current?.transition || editorState.current?.build)} bind:this={anchors.motion} onclick={() => openSlideMenu('motion', null)} disabled={noSlide} title="Transition" aria-label="Transition" aria-expanded={open.motion} data-testid="slide-motion">
      <span class="i-lucide-sparkles"></span><span class="label roomy">Transition</span>
    </button>
    <button class="tool labelled" bind:this={anchors.theme} onclick={() => openSlideMenu('theme', null)} title="Theme" aria-label="Theme" aria-expanded={open.theme} data-testid="deck-theme">
      <span class="i-lucide-palette"></span><span class="label roomy">Theme</span>
    </button>
  </span>
  <button class="tool labelled slide-compact" bind:this={anchors.slideMore} onclick={() => (open.slideMore = !open.slideMore)} disabled={noSlide} title="Layout, background, transition and theme" aria-label="Layout, background, transition and theme" aria-expanded={open.slideMore} data-testid="slide-options">
    <span class="i-lucide-palette"></span><span class="i-lucide-chevron-down text-xs"></span>
  </button>
{/snippet}

<Popover bind:open={open.slideMore} anchor={anchors.slideMore} label="Layout, background, transition and theme">
  <button class="menu-item" onclick={() => openSlideMenu('relayout', anchors.slideMore ?? null)} data-testid="slide-options-layout"><span class="i-lucide-layout-template"></span>Layout</button>
  <button class="menu-item" onclick={() => openSlideMenu('background', anchors.slideMore ?? null)} data-testid="slide-options-background"><span class="i-lucide-paint-roller"></span>Background</button>
  <button class="menu-item" onclick={() => openSlideMenu('motion', anchors.slideMore ?? null)} data-testid="slide-options-motion"><span class="i-lucide-sparkles"></span>Transition</button>
  <button class="menu-item" onclick={() => openSlideMenu('theme', anchors.slideMore ?? null)} data-testid="slide-options-theme"><span class="i-lucide-palette"></span>Theme</button>
</Popover>

<Popover bind:open={open.shape} anchor={anchors.shape} label="Shapes">
  {#each SHAPES as item (item.shape)}
    <button class="menu-item" onclick={() => pick(() => editorState.armTool({ kind: 'shape', shape: item.shape }))} data-testid="shape-{item.shape}">
      <span class={item.icon}></span>{item.label}
    </button>
  {/each}
  <button class="menu-item" onclick={() => pick(() => editorState.armTool({ kind: 'line', arrow: false }))} data-testid="shape-line">
    <span class="i-lucide-minus"></span>Line
  </button>
  <button class="menu-item" onclick={() => pick(() => editorState.armTool({ kind: 'line', arrow: true }))} data-testid="shape-arrow">
    <span class="i-lucide-move-right"></span>Arrow
  </button>
</Popover>

<Popover bind:open={open.colour} anchor={anchors.colour} label="Text colour">
  <ColourPanel value={textColour} {palette} themeChoice="Theme colour" onPick={colour => pick(() => editorState.setTextColour(colour))} />
</Popover>

<Popover bind:open={open.align} anchor={anchors.align} label="Align">
  <div class="icon-row">
    <button class="tool" class:on={align === 'left'} onclick={() => pick(() => editorState.setAlign('left'))} title="Left" aria-label="Align left"><span class="i-lucide-align-left"></span></button>
    <button class="tool" class:on={align === 'center'} onclick={() => pick(() => editorState.setAlign('center'))} title="Centre" aria-label="Align centre"><span class="i-lucide-align-center"></span></button>
    <button class="tool" class:on={align === 'right'} onclick={() => pick(() => editorState.setAlign('right'))} title="Right" aria-label="Align right"><span class="i-lucide-align-right"></span></button>
  </div>
  <div class="icon-row">
    <button class="tool" class:on={style?.valign === 'top'} onclick={() => pick(() => editorState.setVerticalAlign('top'))} title="Top" aria-label="Align top"><span class="i-lucide-align-vertical-justify-start"></span></button>
    <button class="tool" class:on={style?.valign === 'middle'} onclick={() => pick(() => editorState.setVerticalAlign('middle'))} title="Middle" aria-label="Align middle"><span class="i-lucide-align-vertical-justify-center"></span></button>
    <button class="tool" class:on={style?.valign === 'bottom'} onclick={() => pick(() => editorState.setVerticalAlign('bottom'))} title="Bottom" aria-label="Align bottom"><span class="i-lucide-align-vertical-justify-end"></span></button>
  </div>
</Popover>

<Popover bind:open={open.fill} anchor={anchors.fill} label="Fill">
  <ColourPanel value={shapes[0]?.fill} {palette} themeChoice="Theme colour" allowNone allowOpacity onPick={colour => pick(() => editorState.updateSelected({ fill: colour ?? undefined }))} />
</Popover>

{#if open.table || open.tableEdit || open.cellFill || open.cellLines}
  {#await loadTableMenus() then { default: TableMenus }}
    <TableMenus
      {editorState}
      {palette}
      anchors={{ table: anchors.table, lines: anchors.tableEdit, fill: anchors.cellFill, borders: anchors.cellLines }}
      bind:insertOpen={open.table}
      bind:linesOpen={open.tableEdit}
      bind:fillOpen={open.cellFill}
      bind:bordersOpen={open.cellLines}
      onDone={close}
    />
  {/await}
{/if}

<Popover bind:open={open.border} anchor={anchors.border} label={boxed ? 'Border' : 'Line'}>
  <ColourPanel
    value={outlined[0]?.stroke}
    {palette}
    themeChoice={shapes.length ? undefined : 'Theme colour'}
    allowNone={boxed}
    onPick={colour => pick(() => editorState.updateSelected({ stroke: colour ?? undefined }))}
  />
  <div class="menu-divider"></div>
  <div class="menu-label">Thickness</div>
  <div class="icon-row">
    {#each WIDTHS as width (width)}
      <button
        class="tool"
        class:on={(outlined[0]?.strokeWidth ?? (outlined[0]?.type === 'line' ? 4 : outlined[0]?.type === 'table' ? 1.5 : 3)) === width}
        onclick={() => pick(() => editorState.updateSelected({ strokeWidth: width }))}
        title={String(width)}
        aria-label="Thickness {width}"
      >
        <span class="stroke-sample" style:height="{Math.min(width, 10)}px"></span>
      </button>
    {/each}
  </div>
  {#if lines.length > 0}
    <div class="menu-divider"></div>
    <button class="menu-item" onclick={() => pick(() => editorState.updateSelected({ arrow: lines[0]?.arrow ? undefined : true }))} data-testid="line-arrow">
      <span class="i-lucide-move-right"></span>Arrowhead
      {#if lines[0]?.arrow}<span class="i-lucide-check ml-auto"></span>{/if}
    </button>
  {/if}
</Popover>

<Popover bind:open={open.arrange} anchor={anchors.arrange} label="Arrange">
  <button class="menu-item" onclick={() => pick(() => editorState.arrange('front'))} data-testid="arrange-front"><span class="i-lucide-bring-to-front"></span>Bring to front</button>
  <button class="menu-item" onclick={() => pick(() => editorState.arrange('forward'))} data-testid="arrange-forward"><span class="i-lucide-arrow-up"></span>Bring forward</button>
  <button class="menu-item" onclick={() => pick(() => editorState.arrange('backward'))} data-testid="arrange-backward"><span class="i-lucide-arrow-down"></span>Send backward</button>
  <button class="menu-item" onclick={() => pick(() => editorState.arrange('back'))} data-testid="arrange-back"><span class="i-lucide-send-to-back"></span>Send to back</button>
  <div class="menu-divider"></div>
  <div class="menu-label">Place on slide</div>
  <div class="icon-row">
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('left'))} title="Left" aria-label="Place at left"><span class="i-lucide-align-start-vertical"></span></button>
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('centre'))} title="Centre" aria-label="Place at centre"><span class="i-lucide-align-center-vertical"></span></button>
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('right'))} title="Right" aria-label="Place at right"><span class="i-lucide-align-end-vertical"></span></button>
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('top'))} title="Top" aria-label="Place at top"><span class="i-lucide-align-start-horizontal"></span></button>
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('middle'))} title="Middle" aria-label="Place at middle"><span class="i-lucide-align-center-horizontal"></span></button>
    <button class="tool" onclick={() => pick(() => editorState.alignToSlide('bottom'))} title="Bottom" aria-label="Place at bottom"><span class="i-lucide-align-end-horizontal"></span></button>
  </div>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => pick(() => editorState.duplicateSelected())} data-testid="duplicate-selection"><span class="i-lucide-copy"></span>Duplicate</button>
</Popover>

{#if open.layout || open.relayout || open.background || open.theme || open.motion}
  {#await loadSlideMenus() then { default: SlideMenus }}
    <SlideMenus
      {editorState}
      {palette}
      anchors={{ layout: anchors.layout, relayout: compactAnchor ?? anchors.relayout, background: compactAnchor ?? anchors.background, theme: compactAnchor ?? anchors.theme, motion: compactAnchor ?? anchors.motion }}
      bind:layoutOpen={open.layout}
      bind:relayoutOpen={open.relayout}
      bind:backgroundOpen={open.background}
      bind:themeOpen={open.theme}
      bind:motionOpen={open.motion}
      onDone={close}
    />
  {/await}
{/if}

<style>
  .shell {
    flex: none;
    border-bottom: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
  }

  .toolbar {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 41px;
    padding: 4px 8px;
    overflow-x: auto;
    scrollbar-width: none;
    outline: none;
  }

  .toolbar.more-after {
    mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent);
  }

  .toolbar.more-before {
    mask-image: linear-gradient(to left, #000 calc(100% - 40px), transparent);
  }

  .toolbar.more-before.more-after {
    mask-image: linear-gradient(to right, transparent, #000 40px, #000 calc(100% - 40px), transparent);
  }

  .toolbar::-webkit-scrollbar {
    display: none;
  }

  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: none;
    min-width: 32px;
    height: 32px;
    padding: 0 7px;
    border-radius: 6px;
    color: rgb(var(--text-1));
    font-size: 1rem;
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

  .tool.narrow {
    min-width: 24px;
    padding: 0 3px;
    font-size: 0.85rem;
  }

  .labelled {
    padding: 0 10px 0 8px;
  }

  .label {
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .split {
    display: flex;
    flex: none;
  }

  .split .labelled {
    padding-right: 6px;
    border-radius: 6px 0 0 6px;
  }

  .caret {
    min-width: 22px;
    padding: 0 3px;
    border-radius: 0 6px 6px 0;
    font-size: 0.8rem;
  }

  .divider {
    flex: none;
    width: 1px;
    height: 20px;
    margin: 0 5px;
    background: rgb(var(--surface-3));
  }

  .spacer {
    flex: 1;
    min-width: 8px;
  }

  .size {
    display: flex;
    align-items: center;
    flex: none;
  }

  .size-input {
    width: 36px;
    height: 26px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 5px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.8125rem;
    text-align: center;
    outline: none;
  }

  .size-input:focus {
    border-color: #916dfe;
  }

  .ink {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    font-size: 0.95rem;
    line-height: 1;
  }

  .ink-bar {
    width: 18px;
    height: 4px;
    border-radius: 2px;
    border: 1px solid rgb(128 128 128 / 0.4);
    box-sizing: border-box;
  }

  .ink-none {
    background: repeating-linear-gradient(135deg, transparent 0 2px, rgb(128 128 128 / 0.7) 2px 3px);
  }

  .icon-row {
    display: flex;
    gap: 2px;
    padding: 2px 4px;
  }

  .stroke-sample {
    display: block;
    width: 20px;
    border-radius: 1px;
    background: currentColor;
  }

  .slide-wide {
    display: contents;
  }

  .slide-compact {
    display: none;
  }

  /* The words beside the last icons make way when the row fills up with what can be done to a selection. */
  @container (max-width: 1300px) {
    .busy .roomy {
      display: none;
    }
  }

  /* When that is still not enough, the slide's four buttons become one. */
  .folded .slide-wide {
    display: none;
  }

  .folded .slide-compact {
    display: inline-flex;
  }

  @media (max-width: 639px) {
    .label {
      display: none;
    }

    .labelled {
      padding: 0 7px;
    }

    /* Big enough for a finger, and few enough to fit across a phone without scrolling. */
    .tool {
      min-width: 34px;
      height: 36px;
      padding: 0 6px;
    }

    .toolbar {
      padding: 4px 6px;
    }

    .toolbar > .divider {
      display: none;
    }
  }

  .sheet-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sheet-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 0 2px 6px;
  }

  .sheet-row .label {
    display: inline;
  }

  .sheet-row .labelled {
    padding: 0 12px 0 10px;
    background: rgb(var(--surface-2) / 0.6);
  }
</style>
