<script lang="ts">
  /** Formatting controls for the document editor. */
  import type { Editor } from '@tiptap/core';
  import PopupMenu, { type MenuItem } from '../Sheets/PopupMenu.svelte';

  interface Props {
    editor: Editor;
    hasTextSelection: boolean;
    userNpub: string | null;
    commentsCount: number;
    commentsPanelOpen: boolean;
    onAddComment: () => void;
    onToggleCommentsPanel: () => void;
    onImageUpload: () => void;
    onLink: () => void;
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
    onLink,
  }: Props = $props();

  // The editor is not reactive; count its changes so the buttons follow the cursor.
  let changes = $state(0);
  $effect(() => {
    const current = editor;
    let listening = true;
    // A transaction can arrive while the page is being redrawn or taken down
    // (the editor loses focus as it is removed), so the count changes after it.
    const bump = () => {
      queueMicrotask(() => {
        if (listening) changes += 1;
      });
    };
    current.on('transaction', bump);
    return () => {
      listening = false;
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

  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  function keepEditorFocus(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('select')) event.preventDefault();
  }

  // Outside a table the button adds one; inside, it offers what changes it.
  let tableMenu = $state<{ x: number; y: number } | null>(null);
  const tableItems: MenuItem[] = [
    { label: 'Insert row above', icon: 'i-lucide-between-horizontal-start', action: () => editor.chain().focus().addRowBefore().run() },
    { label: 'Insert row below', icon: 'i-lucide-between-horizontal-end', action: () => editor.chain().focus().addRowAfter().run() },
    { label: 'Insert column left', icon: 'i-lucide-between-vertical-start', action: () => editor.chain().focus().addColumnBefore().run() },
    { label: 'Insert column right', icon: 'i-lucide-between-vertical-end', action: () => editor.chain().focus().addColumnAfter().run() },
    { label: 'Delete row', icon: 'i-lucide-trash-2', divider: true, action: () => editor.chain().focus().deleteRow().run() },
    { label: 'Delete column', icon: 'i-lucide-trash-2', action: () => editor.chain().focus().deleteColumn().run() },
    { label: 'Delete table', icon: 'i-lucide-trash-2', danger: true, action: () => editor.chain().focus().deleteTable().run() },
  ];

  function onTable(event: MouseEvent): void {
    if (!editor.isActive('table')) {
      editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run();
      return;
    }
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    tableMenu = { x: bounds.left, y: bounds.bottom + 4 };
  }

  function closeTableMenu(): void {
    tableMenu = null;
    editor.commands.focus();
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
  <button onclick={() => window.print()} class="tool wide-only" title="Print or save as PDF" aria-label="Print">
    <span class="i-lucide-printer"></span>
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
  <button onclick={() => editor.chain().focus().toggleUnderline().run()} class="tool" class:on={active('underline')} title="Underline" aria-label="Underline" aria-pressed={active('underline')}>
    <span class="i-lucide-underline"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleStrike().run()} class="tool" class:on={active('strike')} title="Strikethrough" aria-label="Strikethrough" aria-pressed={active('strike')}>
    <span class="i-lucide-strikethrough"></span>
  </button>
  <button onclick={() => editor.chain().focus().toggleCode().run()} class="tool" class:on={active('code')} title="Code" aria-label="Code" aria-pressed={active('code')}>
    <span class="i-lucide-code"></span>
  </button>
  <button onclick={onLink} class="tool" class:on={active('link')} title="Link ({MOD}K)" aria-label="Link" aria-pressed={active('link')}>
    <span class="i-lucide-link"></span>
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
  <button onclick={onTable} class="tool" class:on={active('table')} title="Table" aria-label="Table" aria-haspopup={active('table') ? 'menu' : undefined}>
    <span class="i-lucide-table"></span>
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

{#if tableMenu}
  <PopupMenu x={tableMenu.x} y={tableMenu.y} items={tableItems} onclose={closeTableMenu} />
{/if}

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  /* Centred while it fits; margins, unlike centring, leave both ends reachable when it scrolls. */
  .toolbar > :global(:first-child) {
    margin-left: auto;
  }

  .toolbar > :global(:last-child) {
    margin-right: auto;
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

  /* Phones print seldom; the row there keeps to writing. */
  @media (max-width: 640px) {
    .tool.wide-only {
      display: none;
    }
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
