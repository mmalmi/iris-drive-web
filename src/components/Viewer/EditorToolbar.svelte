<script lang="ts">
  /** Formatting controls for the document editor. */
  import type { Editor } from '@tiptap/core';

  interface Props {
    editor: Editor;
    hasTextSelection: boolean;
    userNpub: string | null;
    commentsCount: number;
    commentsPanelOpen: boolean;
    onAddComment: () => void;
    onToggleCommentsPanel: () => void;
    onImageUpload: () => void;
  }

  let {
    editor,
    hasTextSelection,
    userNpub,
    commentsCount,
    commentsPanelOpen,
    onAddComment,
    onToggleCommentsPanel,
    onImageUpload,
  }: Props = $props();

  // The editor is not reactive; count its changes so the buttons follow the cursor.
  let changes = $state(0);
  $effect(() => {
    const current = editor;
    const bump = () => {
      changes += 1;
    };
    current.on('transaction', bump);
    return () => {
      current.off('transaction', bump);
    };
  });

  function active(name: string, attributes?: Record<string, unknown>): boolean {
    void changes;
    return editor.isActive(name, attributes);
  }

  let blockStyle = $derived.by(() => {
    void changes;
    for (const level of [1, 2, 3]) {
      if (editor.isActive('heading', { level })) return `h${level}`;
    }
    return 'p';
  });
  let canUndo = $derived.by(() => {
    void changes;
    return editor.can().undo();
  });
  let canRedo = $derived.by(() => {
    void changes;
    return editor.can().redo();
  });

  function keepEditorFocus(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('select')) event.preventDefault();
  }

  function setBlockStyle(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const chain = editor.chain().focus();
    if (value === 'p') chain.setParagraph().run();
    else chain.setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 }).run();
  }
</script>

<!-- Pressing a button must not take the cursor out of the text. -->
<div
  class="toolbar shrink-0 border-b border-surface-2 bg-surface-1"
  role="toolbar"
  tabindex="-1"
  aria-label="Formatting"
  data-testid="document-toolbar"
  onmousedown={keepEditorFocus}
>
  <button onclick={() => editor.chain().focus().undo().run()} disabled={!canUndo} class="tool" title="Undo" aria-label="Undo">
    <span class="i-lucide-undo-2"></span>
  </button>
  <button onclick={() => editor.chain().focus().redo().run()} disabled={!canRedo} class="tool" title="Redo" aria-label="Redo">
    <span class="i-lucide-redo-2"></span>
  </button>

  <span class="divider"></span>

  <select class="style-select" value={blockStyle} onchange={setBlockStyle} aria-label="Text style" data-testid="document-text-style">
    <option value="p">Text</option>
    <option value="h1">Heading 1</option>
    <option value="h2">Heading 2</option>
    <option value="h3">Heading 3</option>
  </select>

  <span class="divider"></span>

  <button onclick={() => editor.chain().focus().toggleBold().run()} class="tool" class:on={active('bold')} title="Bold" aria-label="Bold" aria-pressed={active('bold')}>
    <span class="i-lucide-bold"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleItalic().run()} class="tool" class:on={active('italic')} title="Italic" aria-label="Italic" aria-pressed={active('italic')}>
    <span class="i-lucide-italic"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleStrike().run()} class="tool" class:on={active('strike')} title="Strikethrough" aria-label="Strikethrough" aria-pressed={active('strike')}>
    <span class="i-lucide-strikethrough"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleCode().run()} class="tool" class:on={active('code')} title="Code" aria-label="Code" aria-pressed={active('code')}>
    <span class="i-lucide-code"></span>
  </button>

  <span class="divider"></span>

  <button onclick={() => editor.chain().focus().toggleBulletList().run()} class="tool" class:on={active('bulletList')} title="Bulleted list" aria-label="Bulleted list" aria-pressed={active('bulletList')}>
    <span class="i-lucide-list"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleOrderedList().run()} class="tool" class:on={active('orderedList')} title="Numbered list" aria-label="Numbered list" aria-pressed={active('orderedList')}>
    <span class="i-lucide-list-ordered"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleBlockquote().run()} class="tool" class:on={active('blockquote')} title="Quote" aria-label="Quote" aria-pressed={active('blockquote')}>
    <span class="i-lucide-quote"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleCodeBlock().run()} class="tool" class:on={active('codeBlock')} title="Code block" aria-label="Code block" aria-pressed={active('codeBlock')}>
    <span class="i-lucide-square-code"></span>
  </button>
  <button onclick={onImageUpload} class="tool" title="Add image" aria-label="Add image">
    <span class="i-lucide-image"></span>
  </button>

  <span class="divider"></span>

  <button
    onclick={onAddComment}
    disabled={!hasTextSelection || !userNpub}
    class="tool"
    title={hasTextSelection ? 'Comment on selection' : 'Select text to comment'}
    aria-label="Comment on selection"
    data-testid="document-add-comment"
  >
    <span class="i-lucide-message-square-plus"></span>
  </button>
  <button
    onclick={onToggleCommentsPanel}
    class="tool"
    class:on={commentsPanelOpen}
    title="Comments"
    aria-label="Comments"
    aria-pressed={commentsPanelOpen}
    data-testid="document-comments-toggle"
  >
    <span class="i-lucide-message-square"></span>
    {#if commentsCount > 0}
      <span class="text-xs ml-1" data-testid="document-comments-count">{commentsCount}</span>
    {/if}
  </button>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  @media (min-width: 900px) {
    .toolbar {
      justify-content: center;
    }
  }

  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    min-width: 32px;
    height: 32px;
    padding: 0 7px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 1rem;
    cursor: pointer;
  }

  .tool:hover:not(:disabled) {
    background: rgb(var(--surface-2));
  }

  .tool.on {
    background: rgb(145 109 254 / 0.18);
    color: #916dfe;
  }

  .tool:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .divider {
    flex: none;
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background: rgb(var(--surface-3));
  }

  .style-select {
    flex: none;
    height: 32px;
    padding: 0 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    cursor: pointer;
  }

  .style-select:hover {
    background: rgb(var(--surface-2));
  }
</style>
