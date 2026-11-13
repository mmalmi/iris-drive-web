<script lang="ts">
  /**
   * The presenter's own window: the slide the audience sees, the one that
   * comes next, the notes, the time and how long the talk has run. It moves
   * the audience's window and is moved by it.
   */
  import { onMount } from 'svelte';
  import type { Slide } from '../../lib/slides/model';
  import type { Theme } from '../../lib/slides/themes';
  import { Presentation } from '../../lib/slides/presentation.svelte';
  import { formatElapsed, presentationKey } from '../../lib/slides/presentSync';
  import SlideView from './SlideView.svelte';

  interface Props {
    slides: Slide[];
    theme: Theme;
    urls: Map<string, string>;
    title: string;
    /** Goes up when the deck changes, so notes edited meanwhile show. */
    revision: number;
  }
  let { slides, theme, urls, title, revision }: Props = $props();

  let over = $state(false);
  const run = new Presentation({
    slides: () => slides,
    startId: null,
    key: presentationKey(window.location),
    leads: false,
    onEnd: () => (over = true),
  });

  let root: HTMLElement | undefined = $state();
  let mainWidth = $state(0);
  let mainHeight = $state(0);
  let sideWidth = $state(0);
  let now = $state(Date.now());
  let startedAt = $state(Date.now());

  let slide = $derived(run.slide);
  let following = $derived(run.following);
  let notes = $derived.by(() => {
    void revision;
    return slide?.notes?.toString() ?? '';
  });
  let currentWidth = $derived(Math.max(0, Math.min(mainWidth, mainHeight * 16 / 9)));
  let clock = $derived(new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  let elapsed = $derived(formatElapsed(now - startedAt));

  function go(action: () => void): void {
    over = false;
    action();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;
    if (key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown' || key === ' ' || key === 'Enter' || key === 'n') go(() => run.next());
    else if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp' || key === 'Backspace' || key === 'p') go(() => run.previous());
    else if (key === 'Home') go(() => run.first());
    else if (key === 'End') go(() => run.last());
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  onMount(() => {
    root?.focus();
    const ticking = setInterval(() => (now = Date.now()), 1000);
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(ticking);
      window.removeEventListener('keydown', onKey, true);
      run.close();
    };
  });
</script>

<div class="presenter" bind:this={root} tabindex="-1" role="application" aria-label="Presenter view" data-testid="presenter-view" data-slide-index={run.ended ? -1 : run.index} data-step={run.step}>
  <header class="bar">
    <span class="clock" title="Time" data-testid="presenter-clock">{clock}</span>
    <button class="timer" onclick={() => (startedAt = Date.now())} title="Start the timer again" data-testid="presenter-timer">
      <span class="i-lucide-timer"></span>{elapsed}
    </button>
    <span class="name">{title}</span>
    {#if run.steps > 0 && !run.ended}
      <span class="points" data-testid="presenter-points">Point {run.step} of {run.steps}</span>
    {/if}
    <span class="count" data-testid="presenter-count">{run.count ? (run.ended ? run.count : run.index + 1) : 0} / {run.count}</span>
  </header>

  <div class="body">
    <section class="main" bind:clientWidth={mainWidth} bind:clientHeight={mainHeight}>
      {#if run.ended || !slide}
        <div class="closing">{run.count ? 'End of presentation' : 'No slides'}</div>
      {:else if currentWidth > 0}
        <div class="current" data-testid="presenter-current">
          <SlideView {slide} {theme} {urls} width={currentWidth} step={run.step} />
        </div>
      {/if}
    </section>

    <aside class="side">
      <div class="coming" bind:clientWidth={sideWidth}>
        <h2>Next</h2>
        <div class="next" data-testid="presenter-next">
          {#if slide && run.step < run.steps && sideWidth > 0}
            <!-- What the next press brings: the next point of this slide. -->
            <SlideView {slide} {theme} {urls} width={sideWidth} step={run.step + 1} />
          {:else if following && sideWidth > 0}
            <SlideView slide={following} {theme} {urls} width={sideWidth} step={0} />
          {:else}
            <div class="nothing" style:aspect-ratio="16 / 9">{run.ended ? '' : 'Last slide'}</div>
          {/if}
        </div>
      </div>
      <div class="speaking">
        <h2>Notes</h2>
        <div class="notes" data-testid="presenter-notes">{#if notes}{notes}{:else}<span class="none">No notes for this slide</span>{/if}</div>
      </div>
    </aside>
  </div>

  <footer class="bar">
    <button class="step" onclick={() => go(() => run.previous())} disabled={run.index === 0 && !run.ended} data-testid="presenter-previous">
      <span class="i-lucide-chevron-left"></span>Previous
    </button>
    <button class="step forward" onclick={() => go(() => run.next())} disabled={run.ended} data-testid="presenter-forward">
      Next<span class="i-lucide-chevron-right"></span>
    </button>
    {#if over}
      <span class="over" data-testid="presenter-over">The presentation was closed in the other window</span>
    {/if}
  </footer>
</div>

<style>
  .presenter {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    background: #111214;
    color: #f2f2f4;
    outline: none;
    color-scheme: dark;
  }

  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 52px;
    padding: 8px 16px;
    background: #1b1c20;
  }

  .clock {
    font-size: 1.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .timer {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: #2a2b31;
    color: #f2f2f4;
    font-size: 1.125rem;
    font-variant-numeric: tabular-nums;
  }

  .timer:hover {
    background: #36373e;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    font-size: 0.875rem;
    color: #a4a6ad;
  }

  .points {
    font-size: 0.875rem;
    color: #a4a6ad;
    font-variant-numeric: tabular-nums;
  }

  .count {
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 16px;
    padding: 16px;
  }

  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .current {
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 0 0 1px #33343a;
  }

  .closing {
    color: #8b8d94;
  }

  .side {
    flex: none;
    width: min(34%, 420px);
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  h2 {
    flex: none;
    margin: 0 0 6px;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #8b8d94;
  }

  .coming {
    flex: none;
    margin-bottom: 16px;
  }

  .speaking {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .next {
    border-radius: 4px;
    overflow: hidden;
    box-shadow: 0 0 0 1px #33343a;
  }

  .nothing {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #8b8d94;
    font-size: 0.875rem;
  }

  .notes {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    font-size: 1.25rem;
    line-height: 1.5;
  }

  .none {
    color: #6f7178;
    font-size: 1rem;
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 999px;
    background: #2a2b31;
    color: #f2f2f4;
    font-size: 0.9375rem;
  }

  .step:hover:not(:disabled) {
    background: #36373e;
  }

  .step:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .forward {
    background: #7647fe;
  }

  .forward:hover:not(:disabled) {
    background: #8558ff;
  }

  .over {
    margin-left: auto;
    font-size: 0.875rem;
    color: #a4a6ad;
  }

  /* On a narrow screen everything is stacked: the slide, the notes, what comes next. */
  @media (max-width: 760px) {
    .body {
      flex-direction: column;
      overflow-y: auto;
    }

    .main {
      flex: none;
      height: calc((100vw - 32px) * 9 / 16);
    }

    .side {
      width: 100%;
      flex: none;
    }

    /* The notes come first; what is next is a small picture below them. */
    .speaking {
      order: -1;
      flex: none;
      margin-bottom: 16px;
    }

    .coming {
      width: 50%;
      margin-bottom: 0;
    }

    .notes {
      flex: none;
      overflow: visible;
    }

    .name {
      display: none;
    }

    .count {
      margin-left: auto;
    }
  }
</style>
