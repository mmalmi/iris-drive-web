<script lang="ts">
  /** One cell of a table: its fill and its text, which shrinks to stay inside the cell. */
  import type * as Y from 'yjs';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import { MIN_FIT, fitText, roomInside } from '../../lib/slides/fitText';
  import RichText from './RichText.svelte';
  import TextEditor from './TextEditor.svelte';

  interface Props {
    cell: string;
    fragment: Y.XmlFragment | null;
    fill: string | null;
    color: string;
    bold: boolean;
    /** The cell's size in slide units, so its text is fitted again when that changes. */
    width: number;
    height: number;
    valign: 'top' | 'middle' | 'bottom';
    editing: boolean;
    editorState?: SlidesEditorState;
  }
  let { cell, fragment, fill, color, bold, width, height, valign, editing, editorState }: Props = $props();

  let box: HTMLElement | undefined = $state();
  let inner: HTMLElement | undefined = $state();

  function fit(): void {
    if (box && inner) fitText(box, inner, roomInside(box), MIN_FIT.cell);
  }

  $effect(() => {
    void [width, height, bold, editing, fragment];
    fit();
  });
</script>

<div
  class="el-cell"
  class:el-cell-editing={editing}
  bind:this={box}
  data-cell={cell}
  style:background={fill ?? undefined}
  style:color
  style:font-weight={bold ? 700 : undefined}
  style:justify-content={valign === 'middle' ? 'center' : valign === 'bottom' ? 'flex-end' : 'flex-start'}
>
  <div class="el-text-inner" bind:this={inner}>
    {#if fragment && editing && editorState}
      <TextEditor {fragment} {editorState} onChanged={fit} />
    {:else if fragment}
      <RichText {fragment} onDrawn={fit} />
    {/if}
  </div>
</div>
