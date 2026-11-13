<script lang="ts">
  /**
   * The deck shown to an audience: one slide filling the screen. Keys, a
   * click, or a swipe move through it; Escape leaves. A presenter's window
   * with the notes, when one is open, moves with it.
   */
  import { onMount } from 'svelte';
  import type { Slide } from '../../lib/slides/model';
  import type { Theme } from '../../lib/slides/themes';
  import { Presentation } from '../../lib/slides/presentation.svelte';
  import { presentationKey } from '../../lib/slides/presentSync';
  import SlideView from './SlideView.svelte';

  interface Props {
    slides: Slide[];
    theme: Theme;
    urls: Map<string, string>;
    /** The slide to start on. */
    startId: string | null;
    /** Called when presenting ends, with the slide that was showing. */
    onExit: (slideId: string | null) => void;
    /** Opens the presenter's window. */
    onOpenNotes: () => void;
  }
  let { slides, theme, urls, startId, onExit, onOpenNotes }: Props = $props();

  // svelte-ignore state_referenced_locally
  const run = new Presentation({ slides: () => slides, startId, key: presentationKey(window.location), leads: true });

  let root: HTMLElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  let controls = $state(true);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let touch: { x: number; y: number; time: number } | null = null;
  let wentFullscreen = false;
  let exited = false;

  let index = $derived(run.index);
  let ended = $derived(run.ended);
  let slide = $derived(run.slide);
  let slideWidth = $derived(Math.min(width, height * 16 / 9));

  const show = (target: number) => run.go(target);
  const previous = () => run.previous();

  function next(): void {
    if (!run.next()) exit();
  }

  function exit(): void {
    if (exited) return;
    exited = true;
    const at = slide?.id ?? null;
    run.end();
    if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    onExit(at);
  }

  function wake(): void {
    controls = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (controls = false), 2500);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === 'Escape') exit();
    else if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter' || key === 'n') next();
    else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace' || key === 'p') previous();
    else if (key === 'Home') show(0);
    else if (key === 'End') show(slides.length - 1);
    else if (key === 'f') toggleFullscreen();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function toggleFullscreen(): void {
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.requestFullscreen?.().then(() => (wentFullscreen = true)).catch(() => {});
  }

  function onFullscreenChange(): void {
    // Leaving full screen with the browser's own Escape ends the presentation too.
    if (wentFullscreen && !document.fullscreenElement) exit();
  }

  function onPointerDown(event: PointerEvent): void {
    wake();
    if (event.pointerType !== 'mouse') touch = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  }

  function onPointerUp(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest('[data-present-controls]')) return;
    if (event.pointerType === 'mouse') {
      if (event.button === 0) next();
      return;
    }
    const start = touch;
    touch = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next();
      else previous();
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      // A tap: the left third goes back, the rest goes on.
      if (event.clientX < window.innerWidth / 3) previous();
      else next();
    }
  }

  onMount(() => {
    root?.focus();
    // Asked for while the click that started presenting still counts as the user's doing.
    void root?.requestFullscreen?.().then(() => (wentFullscreen = true)).catch(() => {});
    wake();
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      run.close();
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement === root) void document.exitFullscreen().catch(() => {});
    };
  });
</script>

<div
  class="present"
  class:quiet={!controls}
  bind:this={root}
  bind:clientWidth={width}
  bind:clientHeight={height}
  tabindex="-1"
  role="application"
  aria-label="Presentation"
  data-testid="present-view"
  data-slide-index={ended ? -1 : index}
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
  onpointermove={wake}
  oncontextmenu={(event) => {
    event.preventDefault();
    previous();
  }}
>
  {#if ended || !slide}
    <div class="end" data-testid="present-end">{slides.length ? 'End of presentation' : 'No slides'}</div>
  {:else if slideWidth > 0}
    <SlideView {slide} {theme} {urls} width={slideWidth} />
  {/if}

  <div class="controls" data-present-controls>
    <button class="control" onclick={previous} disabled={index === 0 && !ended} title="Previous" aria-label="Previous slide">
      <span class="i-lucide-chevron-left"></span>
    </button>
    <span class="count" data-testid="present-count">{ended ? slides.length : index + 1} / {slides.length}</span>
    <button class="control" onclick={next} title="Next" aria-label="Next slide" data-testid="present-next">
      <span class="i-lucide-chevron-right"></span>
    </button>
    <button class="control" onclick={onOpenNotes} title="Notes in their own window" aria-label="Notes in their own window" data-testid="present-notes">
      <span class="i-lucide-notebook-text"></span>
    </button>
    <button class="control" onclick={toggleFullscreen} title="Full screen" aria-label="Full screen">
      <span class="i-lucide-maximize"></span>
    </button>
    <button class="control" onclick={exit} title="Exit" aria-label="Exit presentation" data-testid="present-exit">
      <span class="i-lucide-x"></span>
    </button>
  </div>
</div>

<style>
  .present {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    outline: none;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  .present.quiet {
    cursor: none;
  }

  .end {
    color: #8b8b8b;
    font-size: 1rem;
  }

  .controls {
    position: absolute;
    left: 50%;
    bottom: max(16px, env(safe-area-inset-bottom));
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border-radius: 999px;
    background: rgb(28 28 30 / 0.82);
    color: #fff;
    transition: opacity 0.25s;
  }

  .quiet .controls {
    opacity: 0;
    pointer-events: none;
  }

  .control {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: #fff;
    font-size: 1.05rem;
  }

  .control:hover:not(:disabled) {
    background: rgb(255 255 255 / 0.16);
  }

  .control:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .count {
    min-width: 54px;
    text-align: center;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
</style>
