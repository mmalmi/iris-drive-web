<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import { AddCommentModal, CommentsPanel } from '../Comments';
  import EditorToolbar from './EditorToolbar.svelte';

  interface Props {
    title: string;
    backHref: string;
    canEdit: boolean;
    saveStatus: 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'other-tab';
    notice: string;
    editor: Editor | undefined;
    loading: boolean;
    missing: boolean;
    hasTextSelection: boolean;
    userNpub: string | null;
    commentsState: CommentsState;
    commentsStore: CommentsStore | undefined;
    showAddCommentModal: boolean;
    pendingCommentText: string;
    editorElement?: HTMLElement;
    onShare: () => void;
    onDelete: () => void;
    onAddComment: () => void;
    onToggleCommentsPanel: () => void;
    onEditorClick: (event: MouseEvent) => void;
    onClickThread: (threadId: string) => void;
    onDeleteThread: (threadId: string) => void;
    onImageFile: (file: File) => void | Promise<void>;
    onAddCommentSubmit: (commentText: string) => void;
    onAddCommentCancel: () => void;
  }

  let {
    title,
    backHref,
    canEdit,
    saveStatus,
    notice,
    editor,
    loading,
    missing,
    hasTextSelection,
    userNpub,
    commentsState,
    commentsStore,
    showAddCommentModal,
    pendingCommentText,
    editorElement = $bindable(),
    onShare,
    onDelete,
    onAddComment,
    onToggleCommentsPanel,
    onEditorClick,
    onClickThread,
    onDeleteThread,
    onImageFile,
    onAddCommentSubmit,
    onAddCommentCancel,
  }: Props = $props();

  let imageFileInput: HTMLInputElement | undefined = $state();

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
  <div class="shrink-0 h-12 px-2 sm:px-4 border-b border-surface-2 flex items-center gap-2 bg-surface-1">
    <a href={backHref} class="btn-circle btn-ghost shrink-0 no-underline" title="Back to folder" aria-label="Back to folder">
      <span class="i-lucide-arrow-left text-base"></span>
    </a>
    <span class="i-lucide-file-text text-accent shrink-0"></span>
    <h1 class="text-sm font-semibold text-text-1 truncate min-w-0" data-testid="document-title">{title}</h1>
    {#if !canEdit && !loading}
      <span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-2" data-testid="document-view-only">View only</span>
    {/if}

    <div class="ml-auto flex items-center gap-1 shrink-0">
      <span class="text-xs text-text-3 flex items-center gap-1 mr-1" role="status" data-testid="document-save-status">
        {#if saveStatus === 'saving' || saveStatus === 'unsaved'}
          <span class="i-lucide-loader-2 animate-spin"></span>Saving
        {:else if saveStatus === 'saved'}
          <span class="i-lucide-check"></span>Saved
        {:else if saveStatus === 'error'}
          <span class="text-danger flex items-center gap-1"><span class="i-lucide-triangle-alert"></span>Not saved, retrying</span>
        {:else if saveStatus === 'other-tab'}
          Open in another tab
        {/if}
      </span>
      {#if !canEdit && commentsStore && commentsState.threads.size > 0}
        <button onclick={onToggleCommentsPanel} class="btn-circle btn-ghost" title="Comments" aria-label="Comments">
          <span class="i-lucide-message-square text-base"></span>
        </button>
      {/if}
      <button onclick={onShare} class="btn-circle btn-ghost" title="Share" aria-label="Share" data-testid="document-share">
        <span class="i-lucide-share text-base"></span>
      </button>
      {#if canEdit}
        <button onclick={onDelete} class="btn-circle btn-ghost" title="Delete document" aria-label="Delete document" data-testid="document-delete">
          <span class="i-lucide-trash-2 text-base"></span>
        </button>
      {/if}
    </div>
  </div>

  {#if canEdit && editor && !loading}
    <EditorToolbar
      {editor}
      {hasTextSelection}
      {userNpub}
      commentsCount={commentsState.threads.size}
      commentsPanelOpen={commentsState.panelOpen}
      onAddComment={onAddComment}
      onToggleCommentsPanel={onToggleCommentsPanel}
      onImageUpload={() => imageFileInput?.click()}
    />
  {/if}

  {#if notice}
    <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="alert">{notice}</div>
  {/if}

  <div class="flex-1 flex min-h-0">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="flex-1 overflow-auto" onclick={onEditorClick} data-scrollable>
      <div class="document-page">
        {#if loading && missing}
          <div class="flex items-center justify-center min-h-[40vh] text-text-3 text-sm" data-testid="document-missing">
            Document not found
          </div>
        {:else if loading}
          <div class="flex items-center justify-center min-h-[40vh] text-text-3" data-testid="document-loading">
            <span class="i-lucide-loader-2 animate-spin"></span>
          </div>
        {:else}
          <div bind:this={editorElement} class="document-container" data-testid="document-content"></div>
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
    min-height: 100%;
    background: rgb(var(--surface-0));
  }

  @media (min-width: 900px) {
    .document-page {
      max-width: 816px;
      margin: 1.5rem auto;
      min-height: calc(100% - 3rem);
      background: rgb(var(--surface-1));
      border: 1px solid rgb(var(--surface-2));
      border-radius: 6px;
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
</style>
