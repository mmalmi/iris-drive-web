<script lang="ts">
  /**
   * A slide, drawn at a given width. It is always laid out at 1280 × 720 and
   * scaled as a whole, so it looks the same on the canvas, in a thumbnail
   * and on a projector.
   */
  import { SLIDE_HEIGHT, SLIDE_WIDTH, type ElementOverride, type Slide } from '../../lib/slides/model';
  import { paletteFor, resolveColour, type Theme } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import ElementView from './ElementView.svelte';
  import { buildPlan } from '../../lib/slides/motion';

  interface Props {
    slide: Slide;
    theme: Theme;
    urls: Map<string, string>;
    /** Width on screen, in CSS pixels. */
    width: number;
    /** Frames to draw in place of the stored ones, while something is being dragged. */
    overrides?: Record<string, ElementOverride>;
    editorState?: SlidesEditorState;
    /** While presenting: how many steps of the slide's build have been taken. Everything shows when undefined. */
    step?: number;
  }
  let { slide, theme, urls, width, overrides, editorState, step }: Props = $props();

  let plan = $derived(step === undefined ? null : buildPlan(slide));

  let scale = $derived(width / SLIDE_WIDTH);
  let palette = $derived(paletteFor(theme, slide.layout));
  let background = $derived(resolveColour(slide.background, palette) ?? palette.background);
</script>

<div class="slide-box" style:width="{width}px" style:height="{width * SLIDE_HEIGHT / SLIDE_WIDTH}px">
  <div
    class="slide-surface"
    style:width="{SLIDE_WIDTH}px"
    style:height="{SLIDE_HEIGHT}px"
    style:transform="scale({scale})"
    style:background
    style:color={palette.text}
    style:font-family={theme.bodyFont}
    style:--slide-text={palette.text}
    style:--slide-muted={palette.muted}
    style:--slide-accent={palette.accent}
    style:--slide-on-accent={palette.onAccent}
  >
    {#each slide.elements as element (element.id)}
      {@const moved = overrides?.[element.id]}
      {@const offset = plan?.offsets.get(element.id)}
      <ElementView
        element={moved ? { ...element, ...moved } : element}
        {theme}
        {palette}
        layout={slide.layout}
        {urls}
        {editorState}
        revision={editorState?.revision}
        reveal={offset === undefined || step === undefined ? undefined : step - offset}
      />
    {/each}
  </div>
</div>

<style>
  /* Clipped, not scrollable: typing past the edge must not scroll the slide inside its frame. */
  .slide-box {
    position: relative;
    overflow: clip;
    flex: none;
  }

  .slide-surface {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    overflow: clip;
    /* Slides keep their own colours whatever the app's colour scheme. */
    color-scheme: light;
    text-rendering: geometricPrecision;
    -webkit-font-smoothing: antialiased;
    user-select: none;
    -webkit-user-select: none;
  }

  .slide-surface :global(.el) {
    position: absolute;
    box-sizing: border-box;
  }

  .slide-surface :global(.el-line) {
    overflow: visible;
    pointer-events: none;
  }

  .slide-surface :global(.el-line-hit) {
    pointer-events: stroke;
  }

  .slide-surface :global(.el-shape) {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
  }

  .slide-surface :global(.el-image) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    -webkit-user-drag: none;
  }

  .slide-surface :global(.el-image-missing) {
    background: rgb(128 128 128 / 0.18);
  }

  .slide-surface :global(.el-text) {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: 8px 12px;
    box-sizing: border-box;
    overflow-wrap: break-word;
    word-break: normal;
  }

  /* Words in a shape that would not fit even at their smallest are cut off at its edge, never spilled over the slide. */
  .slide-surface :global(.el-text-shape) {
    overflow: hidden;
  }

  .slide-surface :global(.el-table-box),
  .slide-surface :global(.el-table) {
    position: absolute;
    inset: 0;
  }

  .slide-surface :global(.el-table) {
    display: grid;
  }

  .slide-surface :global(.el-cell) {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 6px 12px;
    box-sizing: border-box;
    overflow: hidden;
    /* Set here, where each cell's own share is known, so a crowded cell shrinks alone. */
    font-size: calc(var(--cell-size, 22px) * var(--fit, 1));
    overflow-wrap: break-word;
  }

  /* The lines of a table lie over its cells, centred on their edges, so neighbours share one line however thick. */
  .slide-surface :global(.el-table-lines) {
    position: absolute;
    left: 0;
    top: 0;
    overflow: visible;
    pointer-events: none;
  }

  .slide-surface :global(.el-cell-editing) {
    box-shadow: inset 0 0 0 2px #916dfe;
  }

  .slide-surface :global(.el-cell-picked)::after {
    content: '';
    position: absolute;
    inset: 0;
    /* A blue wash shows on light cells and on cells filled with the theme's own colour alike. */
    background: rgb(40 120 255 / 0.28);
    box-shadow: inset 0 0 0 2px rgb(40 120 255 / 0.9);
    pointer-events: none;
  }

  .slide-surface :global(.el-text-inner) {
    width: 100%;
    min-width: 0;
  }

  .slide-surface :global(.el-editing) {
    user-select: text;
    -webkit-user-select: text;
  }

  .slide-surface :global(.slide-text) {
    outline: none;
    white-space: pre-wrap;
    cursor: inherit;
  }

  .slide-surface :global(.el-editing .slide-text) {
    cursor: text;
    caret-color: currentColor;
  }

  .slide-surface :global(.slide-text p) {
    margin: 0;
  }

  .slide-surface :global(.slide-text ul),
  .slide-surface :global(.slide-text ol) {
    margin: 0;
    padding-left: 1.25em;
    /* A centred or right-aligned list keeps its markers beside its text. */
    text-align: left;
  }

  .slide-surface :global(.slide-text ul) {
    list-style: disc;
  }

  .slide-surface :global(.slide-text ul ul) {
    list-style: circle;
  }

  .slide-surface :global(.slide-text ol) {
    list-style: decimal;
  }

  .slide-surface :global(.slide-text li) {
    margin: 0;
    padding-left: 0.15em;
  }

  .slide-surface :global(.slide-text li + li),
  .slide-surface :global(.slide-text li > ul),
  .slide-surface :global(.slide-text li > ol) {
    margin-top: 0.4em;
  }

  .slide-surface :global(.slide-text li::marker) {
    color: var(--slide-accent);
  }

  .slide-surface :global(.slide-text li.slide-empty-point::marker) {
    content: '';
  }

  /* A point of a slide that builds, as it comes in. */
  .slide-surface :global(.point-in) {
    animation: point-in 0.35s ease-out;
  }

  @keyframes point-in {
    from {
      opacity: 0;
      transform: translateY(0.3em);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .slide-surface :global(.point-in) {
      animation: none;
    }
  }

  .slide-surface :global(.el-hint) {
    opacity: 0.38;
  }
</style>
