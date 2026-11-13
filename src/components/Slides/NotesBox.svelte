<script lang="ts">
  /** Speaker notes for the slide on the canvas: plain text only the presenter needs. */
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';

  interface Props {
    editorState: SlidesEditorState;
  }
  let { editorState }: Props = $props();

  let field: HTMLTextAreaElement | undefined = $state();
  let stored = $derived.by(() => {
    void editorState.revision;
    return editorState.current?.notes?.toString() ?? '';
  });

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
</script>

<textarea
  class="notes"
  bind:this={field}
  placeholder="Speaker notes"
  aria-label="Speaker notes"
  spellcheck="true"
  rows="2"
  oninput={event => editorState.setNotes((event.target as HTMLTextAreaElement).value)}
  data-testid="speaker-notes"
></textarea>

<style>
  .notes {
    flex: none;
    display: block;
    width: 100%;
    height: 68px;
    padding: 10px 16px;
    border: none;
    border-top: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-1));
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.875rem;
    line-height: 1.45;
    resize: none;
    outline: none;
  }

  .notes::placeholder {
    color: rgb(var(--text-3));
  }
</style>
