<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import { AddCommentModal, CommentsPanel } from '../Comments';
  import EditorToolbar from './EditorToolbar.svelte';
  import DocumentHeader from './DocumentHeader.svelte';
  import DocumentLinkMenu from './DocumentLinkMenu.svelte';
  import { printAlone } from '../../lib/printAlone';

  const PRINT_STYLES = `
    @media print {
      .document-print {
        --surface-2: 221 221 221;
        --surface-3: 187 187 187;
        --text-1: 26 26 26;
        --text-2: 85 85 85;
        --text-3: 153 153 153;
      }
      .document-print .ProseMirror { min-height: 0 !important; padding: 0 !important; }
      .document-print .comment-highlight { background: none !important; border: none !important; }
      .document-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `;
  import type { DriveDocument } from '../../lib/yjs';

  interface Props {
    drive: DriveDocument;
    notice: string;
    editor: Editor | undefined;
    hasTextSelection: boolean;
    userNpub: string | null;
    commentsState: CommentsState;
    commentsStore: CommentsStore | undefined;
    showAddCommentModal: boolean;
    pendingCommentText: string;
    editorElement?: HTMLElement;
    /** Holds an earlier version while one is shown. */
    versionElement?: HTMLElement;
    /** True while the field for a link's address is open. */
    linkEditing: boolean;
    onAddComment: () => void;
    onToggleCommentsPanel: () => void;
    onEditorClick: (event: MouseEvent) => void;
    onClickThread: (threadId: string) => void;
    onDeleteThread: (threadId: string) => void;
    onImageFile: (file: File) => void | Promise<void>;
    onAddCommentSubmit: (commentText: string) => void;
    onAddCommentCancel: () => void;
    onRestoreVersion: (update: Uint8Array) => void | Promise<void>;
  }

  let {
    drive,
    notice,
    editor,
    hasTextSelection,
    userNpub,
    commentsState,
    commentsStore,
    showAddCommentModal,
    pendingCommentText,
    editorElement = $bindable(),
    versionElement = $bindable(),
    linkEditing = $bindable(),
    onAddComment,
    onToggleCommentsPanel,
    onEditorClick,
    onClickThread,
    onDeleteThread,
    onImageFile,
    onAddCommentSubmit,
    onAddCommentCancel,
    onRestoreVersion,
  }: Props = $props();

  let canEdit = $derived(drive.canEdit);
  let loading = $derived(drive.loading);
  let missing = $derived(drive.missing);
  let previewing = $derived(!!drive.preview);

  let imageFileInput: HTMLInputElement | undefined = $state();
  let pageElement: HTMLElement | undefined = $state();

  // Printing, from the toolbar or the browser's own menu, prints the page alone,
  // in the colours of the light theme.
  $effect(() => printAlone(() => {
    if (!editorElement) return null;
    const page = editorElement.cloneNode(true) as HTMLElement;
    page.removeAttribute('data-testid');
    for (const node of page.querySelectorAll('[contenteditable]')) node.removeAttribute('contenteditable');
    const holder = document.createElement('div');
    holder.className = 'document-print';
    holder.appendChild(page);
    return holder;
  }, PRINT_STYLES));

  function handleFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void onImageFile(file);
      input.value = '';
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0" data-testid="document-editor">
  <DocumentHeader {drive}>
    {#if !canEdit && commentsStore && commentsState.threads.size > 0}
      <button onclick={onToggleCommentsPanel} class="btn-circle btn-ghost" title="Comments" aria-label="Comments">
        <span class="i-lucide-message-square text-base"></span>
      </button>
    {/if}
  </DocumentHeader>

  {#if previewing}
    {#await import('./VersionBar.svelte') then { default: VersionBar }}
      <VersionBar {drive} onrestore={onRestoreVersion} />
    {/await}
  {:else if canEdit && editor && !loading}
    <EditorToolbar
      {editor}
      {hasTextSelection}
      {userNpub}
      commentsCount={commentsState.threads.size}
      commentsPanelOpen={commentsState.panelOpen}
      onAddComment={onAddComment}
      onToggleCommentsPanel={onToggleCommentsPanel}
      onImageUpload={() => imageFileInput?.click()}
      onLink={() => { linkEditing = true; }}
    />
  {/if}

  {#if notice}
    <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="alert">{notice}</div>
  {/if}

  <div class="flex-1 flex min-h-0">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="flex-1 overflow-auto" onclick={onEditorClick} data-scrollable>
      <div class="document-page" bind:this={pageElement}>
        {#if loading && missing}
          <div class="flex items-center justify-center min-h-[40vh] text-text-3 text-sm" data-testid="document-missing">
            Document not found
          </div>
        {:else if loading}
          <div class="flex items-center justify-center min-h-[40vh] text-text-3" data-testid="document-loading">
            <span class="i-lucide-loader-2 animate-spin"></span>
          </div>
        {:else}
          <div bind:this={editorElement} class="document-container" class:hidden={previewing} data-testid="document-content"></div>
          {#if previewing}
            <div bind:this={versionElement} class="document-container" data-testid="document-version"></div>
          {:else if canEdit && editor && pageElement}
            <DocumentLinkMenu {editor} page={pageElement} bind:editing={linkEditing} />
          {/if}
        {/if}
      </div>
    </div>

    {#if commentsStore && commentsState.panelOpen}
      <div class="w-80 max-w-[85vw] shrink-0 border-l border-surface-2 bg-surface-1">
        <CommentsPanel
          {commentsStore}
          userNpub={canEdit ? userNpub : null}
          onClickThread={onClickThread}
          onDeleteThread={onDeleteThread}
        />
      </div>
    {/if}

    {#if drive.historyOpen}
      {#await import('./VersionHistoryPanel.svelte') then { default: VersionHistoryPanel }}
        <VersionHistoryPanel {drive} />
      {/await}
    {/if}
  </div>
</div>

<input
  bind:this={imageFileInput}
  type="file"
  accept="image/*"
  onchange={handleFileInputChange}
  class="hidden"
/>

<AddCommentModal
  show={showAddCommentModal}
  quotedText={pendingCommentText}
  onSubmit={onAddCommentSubmit}
  onCancel={onAddCommentCancel}
/>

<style>
  .document-page {
    position: relative;
    min-height: 100%;
    background: rgb(var(--surface-0));
  }

  @media (min-width: 900px) {
    .document-page {
      max-width: min(816px, 100% - 3rem);
      margin: 1.5rem auto;
      min-height: calc(100% - 3rem);
      background: rgb(var(--surface-1));
      border: 1px solid rgb(var(--surface-2));
      border-radius: 6px;
    }
  }

  /* A sheet of paper is lighter than the desk it lies on. */
  @media (min-width: 900px) and (prefers-color-scheme: light) {
    .document-page {
      background: #fff;
    }
  }

  .document-container :global(.ProseMirror) {
    min-height: 60vh;
    padding: 1.25rem 1rem 6rem;
    color: rgb(var(--text-1));
    font-size: 1rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }

  @media (min-width: 900px) {
    .document-container :global(.ProseMirror) {
      padding: 3rem 4rem 8rem;
    }
  }

  .document-container :global(.ProseMirror:focus) {
    outline: none;
  }

  .document-container :global(.ProseMirror > * + *) {
    margin-top: 0.75em;
  }

  .document-container :global(.ProseMirror h1) {
    font-size: 1.9rem;
    line-height: 1.25;
    font-weight: 700;
    margin-top: 1.4em;
  }

  .document-container :global(.ProseMirror h2) {
    font-size: 1.45rem;
    line-height: 1.3;
    font-weight: 650;
    margin-top: 1.3em;
  }

  .document-container :global(.ProseMirror h3) {
    font-size: 1.15rem;
    line-height: 1.35;
    font-weight: 650;
    margin-top: 1.2em;
  }

  .document-container :global(.ProseMirror > :first-child) {
    margin-top: 0;
  }

  .document-container :global(.ProseMirror ul),
  .document-container :global(.ProseMirror ol) {
    padding-left: 1.6em;
  }

  .document-container :global(.ProseMirror ul) {
    list-style: disc;
  }

  .document-container :global(.ProseMirror ol) {
    list-style: decimal;
  }

  .document-container :global(.ProseMirror li > p) {
    margin: 0.2em 0;
  }

  .document-container :global(.ProseMirror blockquote) {
    border-left: 3px solid rgb(var(--surface-3));
    padding-left: 1em;
    color: rgb(var(--text-2));
  }

  .document-container :global(.ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: rgb(var(--surface-2));
    border-radius: 4px;
    padding: 0.1em 0.3em;
  }

  .document-container :global(.ProseMirror pre) {
    background: rgb(var(--surface-2));
    border-radius: 6px;
    padding: 0.8em 1em;
    overflow-x: auto;
  }

  .document-container :global(.ProseMirror pre code) {
    background: none;
    padding: 0;
  }

  .document-container :global(.ProseMirror hr) {
    border: none;
    border-top: 1px solid rgb(var(--surface-3));
    margin: 1.5em 0;
  }

  .document-container :global(.ProseMirror a) {
    color: #916dfe;
    text-decoration: underline;
  }

  .document-container :global(.ProseMirror p.is-editor-empty:first-child::before) {
    color: rgb(var(--text-3));
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }

  /* Highlights are light colours: the words on them stay dark, also in the dark theme, unless they have a colour of their own. */
  .document-container :global(.ProseMirror mark:not(span[style*="color"] > mark)) {
    color: #1a1a1a !important;
  }

  .document-container :global(.ProseMirror .tableWrapper) {
    overflow-x: auto;
  }

  .document-container :global(.ProseMirror table) {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .document-container :global(.ProseMirror td),
  .document-container :global(.ProseMirror th) {
    position: relative;
    min-width: 2em;
    padding: 0.3em 0.6em;
    border: 1px solid rgb(var(--surface-3));
    vertical-align: top;
    text-align: left;
  }

  .document-container :global(.ProseMirror th) {
    font-weight: 600;
    background: rgb(var(--surface-2) / 0.6);
  }

  .document-container :global(.ProseMirror td > p),
  .document-container :global(.ProseMirror th > p) {
    margin: 0;
  }

  .document-container :global(.ProseMirror .selectedCell::after) {
    content: '';
    position: absolute;
    inset: 0;
    background: rgb(145 109 254 / 0.15);
    pointer-events: none;
  }

  .document-container :global(.ProseMirror .column-resize-handle) {
    position: absolute;
    top: 0;
    right: -2px;
    bottom: -2px;
    width: 4px;
    background: #916dfe;
    pointer-events: none;
  }

  .document-container :global(.ProseMirror.resize-cursor) {
    cursor: col-resize;
  }

  .document-container :global(.ProseMirror img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }

  .document-container :global(.ProseMirror img.ProseMirror-selectednode) {
    outline: 2px solid #916dfe;
    outline-offset: 2px;
  }

  .document-container :global(.comment-highlight) {
    background-color: rgb(255 204 0 / 0.28);
    border-bottom: 2px solid rgb(255 204 0 / 0.75);
    border-radius: 2px;
    cursor: pointer;
  }

  .document-container :global(.comment-highlight:hover) {
    background-color: rgb(255 204 0 / 0.45);
  }

  /* Where the others who have the document open are writing, in their colour and with their name. */
  .document-container :global(.collaboration-carets__caret) {
    position: relative;
    margin-left: -1px;
    margin-right: -1px;
    border-left: 1px solid;
    border-right: 1px solid;
    word-break: normal;
    pointer-events: none;
  }

  .document-container :global(.collaboration-carets__caret::after) {
    content: attr(data-name);
    position: absolute;
    top: -1.35em;
    left: -1px;
    padding: 0.05rem 0.3rem;
    border-radius: 3px 3px 3px 0;
    background: var(--caret-color);
    color: #fff;
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.3;
    white-space: nowrap;
    user-select: none;
  }
</style>
