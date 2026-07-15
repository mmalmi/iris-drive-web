<script lang="ts">
  import type { Editor } from '@tiptap/core';
  import type { TreeVisibility } from '@hashtree/core';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import { Avatar } from '../User';
  import VisibilityIcon from '../VisibilityIcon.svelte';
  import { AddCommentModal, CommentsPanel } from '../Comments';
  import EditorToolbar from './EditorToolbar.svelte';

  interface Props {
    dirName: string;
    ownerNpub: string | null;
    ownerPubkey: string | null;
    visibility: TreeVisibility;
    canEdit: boolean;
    isOwnTree: boolean;
    isEditor: boolean;
    saveStatus: 'idle' | 'saving' | 'saved' | 'error';
    lastSaved: Date | null;
    collaboratorsCount: number;
    editor: Editor | undefined;
    loading: boolean;
    hasTextSelection: boolean;
    userNpub: string | null;
    commentsState: CommentsState;
    commentsStore: CommentsStore | undefined;
    showAddCommentModal: boolean;
    pendingCommentText: string;
    editorElement?: HTMLElement;
    onShare: () => void;
    onPush: () => void;
    onCollaborators: () => void;
    onFork: () => void;
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
    dirName,
    ownerNpub,
    ownerPubkey,
    visibility,
    canEdit,
    isOwnTree,
    isEditor,
    saveStatus,
    lastSaved,
    collaboratorsCount,
    editor,
    loading,
    hasTextSelection,
    userNpub,
    commentsState,
    commentsStore,
    showAddCommentModal,
    pendingCommentText,
    editorElement = $bindable(),
    onShare,
    onPush,
    onCollaborators,
    onFork,
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

  function triggerImageUpload(): void {
    imageFileInput?.click();
  }

  function handleFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      void onImageFile(file);
      input.value = '';
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0">
  <div class="shrink-0 px-4 py-2 border-b border-surface-3 flex flex-wrap items-center justify-between gap-2 bg-surface-1 text-sm">
    <div class="flex items-center gap-2 min-w-0">
      <a href="#/" class="btn-ghost p-1" title="Back to home">
        <span class="i-lucide-chevron-left text-lg"></span>
      </a>
      {#if ownerPubkey && ownerNpub}
        <a href="#/{ownerNpub}" class="shrink-0">
          <Avatar pubkey={ownerPubkey} size={20} />
        </a>
      {/if}
      <span class="i-lucide-file-text text-text-2 shrink-0"></span>
      <span class="font-medium text-text-1 truncate">{dirName}</span>
      <VisibilityIcon {visibility} class="text-text-2 text-sm" />
      {#if canEdit}
        <span class="i-lucide-pencil text-xs text-text-3" title={isOwnTree ? 'You can edit this document' : 'Editing as editor - saves to your tree'}></span>
      {/if}
      {#if !canEdit}
        <span class="text-xs px-2 py-0.5 rounded bg-surface-2 text-text-3">Read-only</span>
      {/if}
      {#if isEditor && !isOwnTree}
        <span class="text-xs px-2 py-0.5 rounded bg-success/20 text-success" title="You are an editor - edits save to your tree">Editor</span>
      {/if}
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <div class="flex items-center gap-2 text-text-3">
        {#if saveStatus === 'saving'}
          <span class="i-lucide-loader-2 animate-spin"></span>
          <span>Saving...</span>
        {:else if lastSaved}
          <span class="text-xs">Saved {lastSaved.toLocaleTimeString()}</span>
        {/if}
      </div>
      <button onclick={onShare} class="btn-ghost" title="Share document">
        <span class="i-lucide-share"></span>
      </button>
      <button onclick={onPush} class="btn-ghost" title="Push to file servers">
        <span class="i-lucide-upload-cloud"></span>
      </button>
      <button onclick={onCollaborators} class="btn-ghost flex items-center gap-1" title={isOwnTree ? 'Manage editors' : 'View editors'}>
        <span class="i-lucide-users"></span>
        {#if collaboratorsCount > 0}
          <span class="text-xs bg-surface-2 px-1.5 rounded-full">{collaboratorsCount}</span>
        {/if}
      </button>
      <button onclick={onFork} class="btn-ghost flex items-center gap-1" title="Fork document as new tree">
        <span class="i-lucide-git-fork"></span>
        Fork
      </button>
      {#if isOwnTree}
        <button onclick={onDelete} class="btn-ghost text-danger" title="Delete document">Delete</button>
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
      onImageUpload={triggerImageUpload}
    />
  {/if}

  <div class="flex-1 flex min-h-0">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="flex-1 overflow-auto bg-[#0d0d14]" onclick={onEditorClick}>
      <div class="a4-page bg-[#1a1a24]">
        {#if loading}
          <div class="flex items-center justify-center min-h-[400px] text-text-3 p-4 md:p-8">
            <span class="i-lucide-loader-2 animate-spin mr-2"></span>
            Loading document...
          </div>
        {:else}
          <div bind:this={editorElement} class="ProseMirror-container prose prose-sm max-w-none min-h-full"></div>
        {/if}
      </div>
    </div>

    {#if commentsStore}
      <div class="w-80 shrink-0 border-l border-surface-3 {commentsState.panelOpen ? '' : 'hidden'}">
        <CommentsPanel
          {commentsStore}
          {userNpub}
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
  .a4-page {
    min-height: 100%;
  }

  @media (min-width: 900px) {
    .a4-page {
      max-width: 816px;
      margin: 2rem auto;
      min-height: calc(100% - 4rem);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      border-radius: 4px;
    }
  }

  :global(.ProseMirror-container .ProseMirror) {
    min-height: 200px;
    padding: 1rem;
  }

  @media (min-width: 900px) {
    :global(.ProseMirror-container .ProseMirror) {
      padding: 2rem 3rem;
    }
  }

  :global(.ProseMirror-container .ProseMirror:focus) {
    outline: none;
  }

  :global(.ProseMirror-container .ProseMirror p.is-editor-empty:first-child::before) {
    color: var(--color-text-3);
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }

  :global(.ProseMirror-container .ProseMirror img) {
    max-width: 100%;
    height: auto;
    margin: 1rem 0;
    cursor: pointer;
  }

  :global(.ProseMirror-container .ProseMirror img.ProseMirror-selectednode) {
    outline: 3px solid var(--color-accent);
    outline-offset: 3px;
    box-shadow: 0 0 0 6px rgba(var(--color-accent-rgb, 99, 102, 241), 0.2);
    cursor: grab;
  }

  :global(.ProseMirror-container .comment-highlight) {
    background-color: rgba(255, 213, 79, 0.3);
    border-bottom: 2px solid rgba(255, 213, 79, 0.7);
    padding: 0 2px;
    margin: 0 -2px;
    border-radius: 2px;
    cursor: pointer;
    transition: background-color 0.15s;
  }

  :global(.ProseMirror-container .comment-highlight:hover) {
    background-color: rgba(255, 213, 79, 0.5);
  }
</style>
