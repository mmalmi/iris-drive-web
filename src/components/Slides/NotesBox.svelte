<script lang="ts">
  /**
   * Speaker notes for the slide on the canvas: plain text only the presenter
   * needs. On a wide screen the line above them is dragged to give them more
   * or less room; that height is this browser's own and is remembered.
   * Someone who may only view reads them, read-only, and can put them away.
   */
  import { onMount } from 'svelte';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';

  interface Props {
    editorState: SlidesEditorState;
    /** The notes are read, not changed. */
    readonly?: boolean;
    /** Puts the notes away again. */
    onhide?: () => void;
  }
  let { editorState, readonly = false, onhide }: Props = $props();

  const STORE_KEY = 'irisslides-notes-height';
  const DEFAULT_HEIGHT = 84;
  const MIN_HEIGHT = 44;
  const STEP = 24;

  let field: HTMLTextAreaElement | undefined = $state();
  let pane: HTMLElement | undefined = $state();
  let height = $state(readHeight());
  let resizing = $state(false);
  let stored = $derived.by(() => {
    void editorState.revision;
    return editorState.current?.notes?.toString() ?? '';
  });

  function readHeight(): number {
    try {
      const value = Number(localStorage.getItem(STORE_KEY));
      return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
    } catch {
      return DEFAULT_HEIGHT;
    }
  }

  function remember(): void {
    try {
      localStorage.setItem(STORE_KEY, String(Math.round(height)));
    } catch {
      // Without storage the height lasts until the page closes.
    }
  }

  /** The notes may take up to two thirds of the room beside the strip; the slide keeps the rest. */
  function largest(): number {
    const room = pane?.parentElement?.clientHeight ?? 0;
    return room > 0 ? Math.max(MIN_HEIGHT, Math.round(room * 2 / 3)) : 600;
  }

  function setHeight(value: number): void {
    height = Math.round(Math.min(largest(), Math.max(MIN_HEIGHT, value)));
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = height;
    resizing = true;
    const move = (moved: PointerEvent) => setHeight(startHeight + startY - moved.clientY);
    const up = () => {
      resizing = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      remember();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const changes: Record<string, number> = { ArrowUp: height + STEP, ArrowDown: height - STEP, Home: largest(), End: MIN_HEIGHT };
    const next = changes[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    setHeight(next);
    remember();
  }

  /** A double click puts the notes back to their usual size, or tucks them away when they already are. */
  function onDoubleClick(): void {
    setHeight(height === DEFAULT_HEIGHT ? MIN_HEIGHT : DEFAULT_HEIGHT);
    remember();
  }

  // Notes that changed elsewhere show here, without moving the cursor of someone typing the same text.
  $effect(() => {
    const value = stored;
    if (field && field.value !== value) {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      field.value = value;
      if (document.activeElement === field) field.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
    }
  });

  // A window made smaller must not leave the notes taller than there is room for.
  onMount(() => {
    const room = pane?.parentElement;
    if (!room) return;
    const watcher = new ResizeObserver(() => {
      if (height > largest()) setHeight(height);
    });
    watcher.observe(room);
    return () => watcher.disconnect();
  });
</script>

<div class="pane" class:resizing class:closable={!!onhide} bind:this={pane} style:--notes-height="{height}px" data-testid="notes-pane">
  <!-- A focusable separator is a control that resizes; Svelte does not know that kind. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="divider"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Speaker notes size"
    aria-valuenow={height}
    aria-valuemin={MIN_HEIGHT}
    tabindex="0"
    title="Drag to resize the notes"
    onpointerdown={onPointerDown}
    onkeydown={onKeyDown}
    ondblclick={onDoubleClick}
    data-testid="notes-divider"
  ><span class="grip"></span></div>
  <textarea
    class="notes"
    bind:this={field}
    {readonly}
    placeholder={readonly ? 'No notes for this slide' : 'Speaker notes'}
    aria-label="Speaker notes"
    spellcheck={!readonly}
    oninput={readonly ? undefined : event => editorState.setNotes((event.target as HTMLTextAreaElement).value)}
    data-testid="speaker-notes"
  ></textarea>
  {#if onhide}
    <button class="hide btn-circle btn-ghost" onclick={onhide} title="Hide speaker notes" aria-label="Hide speaker notes" data-testid="hide-speaker-notes">
      <span class="i-lucide-x text-xs"></span>
    </button>
  {/if}
</div>

<style>
  .pane {
    position: relative;
    flex: none;
    display: flex;
    flex-direction: column;
    height: var(--notes-height);
    border-top: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
  }

  .divider {
    position: relative;
    flex: none;
    height: 9px;
    margin-top: -5px;
    margin-bottom: -4px;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: row-resize;
    outline: none;
    touch-action: none;
  }

  .grip {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: rgb(var(--surface-3));
    transition: background 0.15s;
  }

  .divider:hover .grip,
  .divider:focus-visible .grip,
  .resizing .grip {
    background: #916dfe;
  }

  .divider:focus-visible::before,
  .resizing .divider::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 4px;
    height: 1px;
    background: #916dfe;
  }

  .notes {
    flex: 1;
    min-height: 0;
    display: block;
    width: 100%;
    padding: 12px 20px;
    border: none;
    background: transparent;
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.9375rem;
    line-height: 1.55;
    resize: none;
    outline: none;
  }

  .resizing .notes {
    pointer-events: none;
  }

  .closable .notes {
    padding-right: 40px;
  }

  .hide {
    position: absolute;
    top: 6px;
    right: 8px;
    width: 24px;
    height: 24px;
    min-height: 0;
  }

  /* On a phone the notes simply take the room under the slide. */
  @media (max-width: 639px) {
    .pane {
      flex: 1;
      height: auto;
      min-height: 68px;
    }

    .divider {
      display: none;
    }

    .notes {
      padding: 10px 16px;
      font-size: 0.875rem;
    }
  }

  .notes::placeholder {
    color: rgb(var(--text-3));
  }
</style>
