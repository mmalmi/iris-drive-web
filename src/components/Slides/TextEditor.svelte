<script lang="ts">
  /** The text of the box being typed in: an editor in the place where the text is otherwise drawn. */
  import { onMount } from 'svelte';
  import type * as Y from 'yjs';
  import { createTextEditor } from '../../lib/slides/richText';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';

  interface Props {
    fragment: Y.XmlFragment;
    editorState: SlidesEditorState;
  }
  let { fragment, editorState }: Props = $props();

  let container: HTMLElement | undefined = $state();

  onMount(() => {
    if (!container) return;
    const host = container;
    const editor = createTextEditor({
      element: host,
      fragment,
      onImage: file => void editorState.addImage(file),
    });
    // The text is laid out in slide units whatever the zoom, so its height is too.
    editorState.measureEditing = () => (host.parentElement?.scrollHeight ?? 0);
    editorState.attachEditor(editor);
    return () => {
      editorState.measureEditing = undefined;
      editorState.detachEditor(editor);
      editor.destroy();
    };
  });
</script>

<div class="slide-text-editor" bind:this={container}></div>
