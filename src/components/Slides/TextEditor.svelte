<script lang="ts" module>
  type TextEditorCode = typeof import('../../lib/slides/richTextEditor');
  let loaded: TextEditorCode | null = null;
  let loading: Promise<TextEditorCode> | null = null;

  /**
   * The editor's code (tiptap) comes apart from the presentation, which loads
   * it for someone who may edit. Once it is here a box starts its editor at
   * once, as soon as it is clicked.
   */
  export function loadTextEditor(): Promise<TextEditorCode> {
    loading ??= import('../../lib/slides/richTextEditor').then(
      (code) => (loaded = code),
      (error: unknown) => {
        // Asked for again the next time, as when the network is back.
        loading = null;
        throw error;
      },
    );
    return loading;
  }
</script>

<script lang="ts">
  /** The text of the box being typed in: an editor in the place where the text is otherwise drawn. */
  import { onMount } from 'svelte';
  import type * as Y from 'yjs';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';

  interface Props {
    fragment: Y.XmlFragment;
    editorState: SlidesEditorState;
    /** Called when the text changed, so the box can fit it again. */
    onChanged?: () => void;
  }
  let { fragment, editorState, onChanged }: Props = $props();

  let container: HTMLElement | undefined = $state();

  function start(host: HTMLElement, { createTextEditor, TYPING_ORIGIN }: TextEditorCode): () => void {
    const editor = createTextEditor({
      element: host,
      fragment,
      onImage: file => void editorState.addImage(file),
      onTab: back => editorState.editNext(back),
    });
    // The text is laid out in slide units whatever the zoom, so its height is too.
    const measure = () => {
      const box = host.closest<HTMLElement>('.el-text');
      if (!box || !host.parentElement) return 0;
      const style = getComputedStyle(box);
      return host.parentElement.offsetHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    };
    editorState.measureEditing = measure;
    // While typing, the box follows its text: fitted again after each change, and its height reported as it grows.
    const changed = () => {
      onChanged?.();
      editorState.editingHeight = measure();
    };
    editor.on('update', changed);
    const watcher = new ResizeObserver(changed);
    if (host.parentElement) watcher.observe(host.parentElement);
    editorState.attachEditor(editor, TYPING_ORIGIN);
    changed();
    return () => {
      watcher.disconnect();
      // When typing moves straight on to another box, that box may already have taken over.
      if (editorState.measureEditing === measure) {
        editorState.measureEditing = undefined;
        editorState.editingHeight = 0;
      }
      editorState.detachEditor(editor);
      editor.destroy();
    };
  }

  onMount(() => {
    if (!container) return;
    const host = container;
    if (loaded) return start(host, loaded);
    // Editing allowed only after the deck opened (access given meanwhile): the code comes now.
    let stop: (() => void) | undefined;
    let gone = false;
    loadTextEditor().then((code) => {
      if (!gone) stop = start(host, code);
    }, (error: unknown) => console.error('[Slides] The text editor could not be loaded:', error));
    return () => {
      gone = true;
      stop?.();
    };
  });
</script>

<div class="slide-text-editor" bind:this={container}></div>
