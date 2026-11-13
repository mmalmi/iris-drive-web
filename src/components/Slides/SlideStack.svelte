<script lang="ts">
  /** The whole deck, one slide under the other, for reading on a phone. A tap on a slide presents from it. */
  import type { Slide } from '../../lib/slides/model';
  import type { Theme } from '../../lib/slides/themes';
  import SlideView from './SlideView.svelte';

  interface Props {
    slides: Slide[];
    theme: Theme;
    urls: Map<string, string>;
    onPresent: (slideId: string) => void;
  }
  let { slides, theme, urls, onPresent }: Props = $props();

  let width = $state(0);
</script>

<div class="stack" bind:clientWidth={width} data-testid="slide-stack" data-scrollable>
  {#each slides as slide, index (slide.id)}
    <button class="page" onclick={() => onPresent(slide.id)} aria-label="Present from slide {index + 1}" data-testid="stack-slide">
      {#if width > 0}
        <SlideView {slide} {theme} {urls} width={width - 24} />
      {/if}
      <span class="number">{index + 1}</span>
    </button>
  {/each}
</div>

<style>
  .stack {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: rgb(var(--surface-0));
    -webkit-overflow-scrolling: touch;
  }

  .page {
    position: relative;
    flex: none;
    display: block;
    padding: 0;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.16), 0 4px 12px rgb(0 0 0 / 0.08);
    -webkit-tap-highlight-color: transparent;
  }

  .number {
    position: absolute;
    left: 8px;
    bottom: 8px;
    min-width: 22px;
    padding: 0 6px;
    border-radius: 11px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
    font-size: 0.75rem;
    line-height: 22px;
    text-align: center;
  }
</style>
