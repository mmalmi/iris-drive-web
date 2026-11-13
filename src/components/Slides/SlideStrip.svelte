<script lang="ts">
  /** The deck as a row of small slides: pick one to work on, drag to reorder. Down the side, or along the bottom on a phone. */
  import { tick } from 'svelte';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import SlideView from './SlideView.svelte';
  import Popover from './Popover.svelte';

  interface Props {
    editorState: SlidesEditorState;
    urls: Map<string, string>;
  }
  let { editorState, urls }: Props = $props();

  const DRAG_START = 5;
  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  let list: HTMLElement | undefined = $state();
  let listWidth = $state(0);
  let listHeight = $state(0);
  let sideways = $derived(listHeight < 140 && listWidth > listHeight);
  let thumbWidth = $derived(sideways ? Math.max(64, Math.round((listHeight - 20) * 16 / 9)) : Math.max(80, listWidth - 48));

  let pressed: { id: string; x: number; y: number; dragging: boolean; picked: boolean } | null = null;
  let dragging = $state(false);
  /** Where the dragged slides would land: before this slide, or at the end when null. */
  let dropBefore = $state<string | null | undefined>(undefined);
  let dropLine = $state(0);
  let menuAt = $state<{ x: number; y: number } | undefined>();
  let menuOpen = $state(false);

  let canEdit = $derived(editorState.canEdit);
  let slides = $derived(editorState.slides);

  // The slide being worked on stays in view.
  $effect(() => {
    const id = editorState.currentId;
    void slides.length;
    if (!id || !list) return;
    void tick().then(() => {
      list?.querySelector(`[data-slide="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  });

  function onPointerDown(event: PointerEvent, id: string): void {
    if (event.button !== 0) return;
    editorState.area = 'strip';
    list?.focus({ preventScroll: true });
    const picked = editorState.pickedSlides.includes(id);
    if (event.shiftKey) editorState.pickSlide(id, 'range');
    else if (event.metaKey || event.ctrlKey) editorState.pickSlide(id, 'toggle');
    else if (!picked) editorState.pickSlide(id, 'only');
    // Dragging by finger scrolls the strip; reordering by touch goes through the menu.
    if (canEdit && event.pointerType === 'mouse' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      pressed = { id, x: event.clientX, y: event.clientY, dragging: false, picked };
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
    } else {
      pressed = null;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pressed || !list) return;
    if (!pressed.dragging && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < DRAG_START) return;
    pressed.dragging = true;
    dragging = true;
    const along = sideways ? event.clientX : event.clientY;
    const bounds = list.getBoundingClientRect();
    // Near either end the strip scrolls so far-away places can be reached.
    const start = sideways ? bounds.left : bounds.top;
    const end = sideways ? bounds.right : bounds.bottom;
    if (along < start + 36) list.scrollBy(sideways ? { left: -14 } : { top: -14 });
    else if (along > end - 36) list.scrollBy(sideways ? { left: 14 } : { top: 14 });

    const items = [...list.querySelectorAll<HTMLElement>('[data-slide]')];
    let before: string | null = null;
    let line = 0;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const middle = sideways ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
      if (along < middle) {
        before = item.dataset.slide!;
        line = (sideways ? rect.left - bounds.left + list.scrollLeft : rect.top - bounds.top + list.scrollTop) - 4;
        break;
      }
    }
    if (before === null && items.length) {
      const rect = items[items.length - 1]!.getBoundingClientRect();
      line = (sideways ? rect.right - bounds.left + list.scrollLeft : rect.bottom - bounds.top + list.scrollTop) + 2;
    }
    dropBefore = before;
    dropLine = line;
  }

  function onPointerUp(event: PointerEvent, id: string): void {
    const press = pressed;
    pressed = null;
    dragging = false;
    const target = dropBefore;
    dropBefore = undefined;
    if (!press) return;
    if (press.dragging) {
      if (target !== undefined) editorState.moveSlides(editorState.pickedSlides, target);
    } else if (press.picked && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      // A plain click on one of several picked slides picks just that one.
      editorState.pickSlide(id, 'only');
    }
  }

  function openMenu(event: MouseEvent, id: string): void {
    event.preventDefault();
    if (!canEdit) return;
    if (!editorState.pickedSlides.includes(id)) editorState.pickSlide(id, 'only');
    editorState.area = 'strip';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // From the keyboard or the ⋯ button there is no pointer position to open at.
    menuAt = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: rect.right - 8, y: rect.bottom - 8 };
    menuOpen = true;
  }

  function run(action: () => void): void {
    menuOpen = false;
    action();
  }

  let firstPicked = $derived(slides.findIndex(slide => editorState.pickedSlides.includes(slide.id)));
  let lastPicked = $derived(slides.findLastIndex(slide => editorState.pickedSlides.includes(slide.id)));
</script>

<div
  class="strip"
  class:sideways
  class:dragging
  bind:this={list}
  bind:clientWidth={listWidth}
  bind:clientHeight={listHeight}
  tabindex="0"
  role="listbox"
  aria-label="Slides"
  aria-orientation={sideways ? 'horizontal' : 'vertical'}
  data-testid="slide-strip"
  onfocus={() => (editorState.area = 'strip')}
>
  {#each slides as slide, index (slide.id)}
    <div
      class="item"
      class:current={slide.id === editorState.currentId}
      class:picked={editorState.pickedSlides.includes(slide.id)}
      data-slide={slide.id}
      data-testid="slide-thumb"
      role="option"
      tabindex="-1"
      aria-selected={editorState.pickedSlides.includes(slide.id)}
      aria-label="Slide {index + 1}"
      onpointerdown={event => onPointerDown(event, slide.id)}
      onpointermove={onPointerMove}
      onpointerup={event => onPointerUp(event, slide.id)}
      onpointercancel={event => onPointerUp(event, slide.id)}
      oncontextmenu={event => openMenu(event, slide.id)}
    >
      <span class="number">{index + 1}</span>
      <div class="thumb">
        <SlideView {slide} theme={editorState.theme} {urls} width={thumbWidth} />
        {#if canEdit}
          <button
            class="more"
            title="Slide options"
            aria-label="Slide options"
            onpointerdown={event => event.stopPropagation()}
            onclick={event => openMenu(event, slide.id)}
          >
            <span class="i-lucide-ellipsis"></span>
          </button>
        {/if}
      </div>
    </div>
  {/each}
  {#if dragging && dropBefore !== undefined}
    <div class="drop-line" style={sideways ? `left:${dropLine}px` : `top:${dropLine}px`}></div>
  {/if}
</div>

<Popover bind:open={menuOpen} anchor={menuAt} label="Slide options">
  <button class="menu-item" onclick={() => run(() => editorState.addSlide())} data-testid="slide-menu-new">
    <span class="i-lucide-plus"></span>New slide
  </button>
  <button class="menu-item" onclick={() => run(() => editorState.duplicateSlides())} data-testid="slide-menu-duplicate">
    <span class="i-lucide-copy"></span>Duplicate<span class="keys">{modifier}D</span>
  </button>
  <div class="menu-divider"></div>
  <button class="menu-item" disabled={firstPicked <= 0} onclick={() => run(() => editorState.shiftSlides(-1))} data-testid="slide-menu-earlier">
    <span class={sideways ? 'i-lucide-arrow-left' : 'i-lucide-arrow-up'}></span>Move earlier
  </button>
  <button class="menu-item" disabled={lastPicked >= slides.length - 1} onclick={() => run(() => editorState.shiftSlides(1))} data-testid="slide-menu-later">
    <span class={sideways ? 'i-lucide-arrow-right' : 'i-lucide-arrow-down'}></span>Move later
  </button>
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => run(() => editorState.deleteSlides())} data-testid="slide-menu-delete">
    <span class="i-lucide-trash-2"></span>Delete
  </button>
</Popover>

<style>
  .strip {
    position: relative;
    flex: none;
    width: 196px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 12px 12px 0;
    overflow-y: auto;
    overflow-x: hidden;
    outline: none;
    border-right: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
    scrollbar-width: thin;
  }

  .strip.sideways {
    flex-direction: row;
    padding: 8px 10px;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .item {
    position: relative;
    flex: none;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }

  .number {
    flex: none;
    width: 30px;
    padding-top: 2px;
    text-align: right;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--text-2));
    user-select: none;
  }

  .sideways .number {
    position: absolute;
    left: 5px;
    bottom: 4px;
    z-index: 1;
    width: auto;
    padding: 0 5px;
    border-radius: 8px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: 0.6875rem;
    line-height: 1.5;
  }

  .thumb {
    position: relative;
    border-radius: 6px;
    overflow: hidden;
    outline: 1px solid rgb(var(--surface-3));
    pointer-events: none;
  }

  .item.picked .thumb {
    outline: 2px solid rgb(145 109 254 / 0.55);
  }

  .item.current .thumb {
    outline: 2.5px solid #916dfe;
  }

  .current .number {
    color: rgb(var(--text-1));
    font-weight: 600;
  }

  .dragging .item.picked {
    opacity: 0.45;
  }

  .more {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 24px;
    height: 24px;
    display: none;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: 0.8rem;
    pointer-events: auto;
  }

  .item:hover .more {
    display: flex;
  }

  /* Without a pointer to hover with, the slide being worked on shows it. */
  @media (hover: none) {
    .item.current .more {
      display: flex;
    }
  }

  .dragging .more {
    display: none !important;
  }

  .drop-line {
    position: absolute;
    left: 36px;
    right: 12px;
    height: 3px;
    border-radius: 2px;
    background: #916dfe;
    pointer-events: none;
  }

  @media (max-width: 639px) {
    .strip {
      width: auto;
      height: 76px;
      border-right: none;
      border-top: 1px solid rgb(var(--surface-2));
    }
  }

  .sideways .drop-line {
    top: 8px;
    bottom: 8px;
    left: auto;
    right: auto;
    width: 3px;
    height: auto;
  }
</style>
