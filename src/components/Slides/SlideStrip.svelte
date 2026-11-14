<script lang="ts">
  /** The deck as a row of small slides: pick one to work on, drag to reorder. Down the side, or along the bottom on a phone. */
  import { tick } from 'svelte';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import SlideView from './SlideView.svelte';
  import Popover from './Popover.svelte';
  import { onSlide } from './PresenceOutlines.svelte';
  import type { PresenceState } from '../../lib/yjs/presence.svelte';

  interface Props {
    editorState: SlidesEditorState;
    urls: Map<string, string>;
    /** Others who have the deck open: each slide shows who is on it. */
    others?: PresenceState[];
    /** The clipboard, for the menu: copy (or cut) the picked slides, and paste after the current one. */
    onCopy?: (cut: boolean) => void;
    onPaste?: () => void;
  }
  let { editorState, urls, others = [], onCopy, onPaste }: Props = $props();

  const DRAG_START = 5;
  /** How long a finger rests on a slide before it picks the slide up, and how far it may wander meanwhile. */
  const HOLD_MS = 350;
  const HOLD_SLACK = 8;
  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  let list: HTMLElement | undefined = $state();
  let listWidth = $state(0);
  let listHeight = $state(0);
  let sideways = $derived(listHeight < 140 && listWidth > listHeight);
  let thumbWidth = $derived(sideways ? Math.max(64, Math.round((listHeight - 20) * 16 / 9)) : Math.max(80, listWidth - 48));

  let pressed: { id: string; x: number; y: number; dragging: boolean; picked: boolean; touch: boolean } | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let byTouch = false;
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
    byTouch = event.pointerType !== 'mouse';
    clearTimeout(holdTimer);
    if (!canEdit || event.shiftKey || event.metaKey || event.ctrlKey) {
      pressed = null;
      return;
    }
    const item = event.currentTarget as HTMLElement;
    const press = { id, x: event.clientX, y: event.clientY, dragging: false, picked, touch: byTouch };
    pressed = press;
    if (!byTouch) {
      item.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    // A finger that moves scrolls the strip; one that rests on a slide for a moment picks it up.
    holdTimer = setTimeout(() => {
      if (pressed !== press) return;
      press.dragging = true;
      dragging = true;
      item.setPointerCapture(event.pointerId);
    }, HOLD_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pressed || !list) return;
    const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
    if (pressed.touch && !pressed.dragging) {
      // Moving before the slide was picked up: this is scrolling.
      if (moved > HOLD_SLACK) {
        clearTimeout(holdTimer);
        pressed = null;
      }
      return;
    }
    if (!pressed.dragging && moved < DRAG_START) return;
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
    clearTimeout(holdTimer);
    const press = pressed;
    pressed = null;
    dragging = false;
    const target = dropBefore;
    dropBefore = undefined;
    if (!press) return;
    if (press.dragging) {
      if (target !== undefined && event.type !== 'pointercancel') editorState.moveSlides(editorState.pickedSlides, target);
    } else if (press.picked && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      // A plain click on one of several picked slides picks just that one.
      editorState.pickSlide(id, 'only');
    }
  }

  // While a slide is being carried by finger, the strip must not scroll under it.
  $effect(() => {
    const strip = list;
    if (!strip) return;
    const hold = (event: TouchEvent) => {
      if (dragging) event.preventDefault();
    };
    strip.addEventListener('touchmove', hold, { passive: false });
    return () => strip.removeEventListener('touchmove', hold);
  });

  function onContextMenu(event: MouseEvent, id: string): void {
    // A long press by finger is how a slide is picked up; the menu is on the ⋯ button.
    if (byTouch) event.preventDefault();
    else openMenu(event, id);
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
      oncontextmenu={event => onContextMenu(event, slide.id)}
    >
      <span class="number">
        {index + 1}
        {#if slide.transition || slide.build}
          <span class="motion i-lucide-sparkles" title="Moves when presented" data-testid="slide-moves"></span>
        {/if}
      </span>
      <div class="thumb">
        <SlideView {slide} theme={editorState.theme} {urls} width={thumbWidth} />
        {#if others.length > 0}
          {@const here = onSlide(others, slide.id)}
          {#if here.length > 0}
            <span class="here" data-testid="slide-thumb-presence">
              {#each here.slice(0, 3) as state (state.clientId)}
                <span class="here-dot" style:background-color={state.user.color} title={state.user.name || 'Someone'} data-name={state.user.name} data-initial={(Array.from(state.user.name.trim() || '?')[0] ?? '?').toUpperCase()}></span>
              {/each}
            </span>
          {/if}
        {/if}
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
    <span class="i-lucide-copy-plus"></span>Duplicate<span class="keys">{modifier}D</span>
  </button>
  {#if onCopy && onPaste}
    <div class="menu-divider"></div>
    <button class="menu-item" onclick={() => run(() => onCopy(true))} data-testid="slide-menu-cut">
      <span class="i-lucide-scissors"></span>Cut<span class="keys">{modifier}X</span>
    </button>
    <button class="menu-item" onclick={() => run(() => onCopy(false))} data-testid="slide-menu-copy">
      <span class="i-lucide-copy"></span>Copy<span class="keys">{modifier}C</span>
    </button>
    <button class="menu-item" onclick={() => run(onPaste)} data-testid="slide-menu-paste">
      <span class="i-lucide-clipboard"></span>Paste<span class="keys">{modifier}V</span>
    </button>
  {/if}
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

  .motion {
    display: block;
    margin: 4px 0 0 auto;
    font-size: 0.75rem;
    color: #916dfe;
  }

  .sideways .motion {
    display: inline-block;
    margin: 0 0 0 3px;
    vertical-align: -1px;
    color: #fff;
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

  /* Who else is on a slide: their initials in a corner of it. */
  .here {
    position: absolute;
    left: 4px;
    bottom: 4px;
    display: flex;
  }

  .here-dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    border: 1.5px solid rgb(var(--surface-1));
    color: #fff;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
  }

  /* An initial, not text of the slide. */
  .here-dot::after {
    content: attr(data-initial);
  }

  .here-dot + .here-dot {
    margin-left: -4px;
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

  .item {
    -webkit-touch-callout: none;
    user-select: none;
    -webkit-user-select: none;
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
