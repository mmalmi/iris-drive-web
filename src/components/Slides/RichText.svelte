<script lang="ts">
  /** The stored text of a box, drawn as it is and redrawn when it changes. */
  import { untrack } from 'svelte';
  import type * as Y from 'yjs';
  import { renderRichText } from '../../lib/slides/richText';
  import { drawnPoints } from '../../lib/slides/motion';

  interface Props {
    fragment: Y.XmlFragment;
    /** Called each time the text has been drawn anew. */
    onDrawn?: () => void;
    /** While presenting a slide that builds: how many of its points are shown so far. All when undefined. */
    reveal?: number;
  }
  let { fragment, onDrawn, reveal }: Props = $props();

  let container: HTMLElement | undefined = $state();
  let shown: number | undefined;

  /** Hides the points not shown yet; those that just came in fade in. */
  function showPoints(target: HTMLElement, count: number | undefined, animate: boolean): void {
    const points = drawnPoints(target);
    points.forEach((point, index) => {
      const visible = count === undefined || index < count;
      point.style.visibility = visible ? '' : 'hidden';
      point.classList.toggle('point-in', animate && visible && shown !== undefined && index >= shown);
    });
    shown = count;
  }

  $effect(() => {
    const target = container;
    const source = fragment;
    if (!target) return;
    const draw = () => {
      renderRichText(source, target);
      untrack(() => {
        if (reveal !== undefined) showPoints(target, reveal, false);
        onDrawn?.();
      });
    };
    draw();
    source.observeDeep(draw);
    return () => source.unobserveDeep(draw);
  });

  $effect(() => {
    const count = reveal;
    if (container && (count !== undefined || shown !== undefined)) showPoints(container, count, true);
  });
</script>

<div class="slide-text" bind:this={container}></div>
