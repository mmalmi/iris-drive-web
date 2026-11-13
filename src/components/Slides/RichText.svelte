<script lang="ts">
  /** The stored text of a box, drawn as it is and redrawn when it changes. */
  import { untrack } from 'svelte';
  import type * as Y from 'yjs';
  import { renderRichText } from '../../lib/slides/richText';

  interface Props {
    fragment: Y.XmlFragment;
    /** Called each time the text has been drawn anew. */
    onDrawn?: () => void;
  }
  let { fragment, onDrawn }: Props = $props();

  let container: HTMLElement | undefined = $state();

  $effect(() => {
    const target = container;
    const source = fragment;
    if (!target) return;
    const draw = () => {
      renderRichText(source, target);
      untrack(() => onDrawn?.());
    };
    draw();
    source.observeDeep(draw);
    return () => source.unobserveDeep(draw);
  });
</script>

<div class="slide-text" bind:this={container}></div>
