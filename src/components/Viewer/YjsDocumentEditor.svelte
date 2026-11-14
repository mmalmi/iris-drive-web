<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { nostrStore } from '../../nostr';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import YjsDocumentShell from './YjsDocumentShell.svelte';
  import {
    ATTACHMENT_SCHEME,
    DriveDocument,
    attachmentFilename,
  } from '../../lib/yjs';
  import { createYjsTiptapEditor, insertPicture } from '../../lib/yjs/tiptapEditor';

  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  let userNpub = $derived($nostrStore.npub);

  let editorElement: HTMLElement | undefined = $state();
  let editor: Editor | undefined = $state();
  let commentsStore: CommentsStore | undefined = $state();
  let commentsState = $state<CommentsState>({ threads: new Map(), activeThreadId: null, panelOpen: false });
  let hasTextSelection = $state(false);
  let showAddCommentModal = $state(false);
  let pendingCommentSelection = $state<{ from: number; to: number; text: string } | null>(null);
  let notice = $state('');
  let linkEditing = $state(false);

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName, {
    onStored: () => {
      for (const img of editorElement?.querySelectorAll('img') ?? []) resolveImageSrc(img);
    },
  });
  let canEdit = $derived(drive.canEdit);

  $effect(() => {
    if (editor && editor.isEditable !== canEdit) editor.setEditable(canEdit);
  });

  /** Shows an attachment once this browser knows where it is; until then the image stays empty. */
  function resolveImageSrc(img: HTMLImageElement): void {
    const filename = attachmentFilename(img.getAttribute('src')) ?? img.dataset.attachment ?? null;
    if (!filename) return;
    img.dataset.attachment = filename;
    const url = drive.attachmentUrls.get(filename);
    if (url && img.getAttribute('src') !== url) img.src = url;
  }

  async function handleImageUpload(file: File, at?: number): Promise<void> {
    if (!canEdit || !editor || !file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_BYTES) {
      notice = 'Images can be up to 20 MB.';
      return;
    }
    notice = '';
    try {
      const filename = await drive.addAttachment(file);
      insertPicture(editor, { src: `${ATTACHMENT_SCHEME}${filename}`, alt: file.name }, at);
    } catch (error) {
      console.error('[Document] Could not add image:', error);
      notice = 'Could not add the image.';
    }
  }

  onMount(() => {
    void (async () => {
      if (!await drive.open()) return;
      await tick();
      if (!editorElement) return;
      const setup = createYjsTiptapEditor({
        element: editorElement,
        ydoc: drive.ydoc,
        canEdit,
        handleImageUpload,
        resolveImageSrc,
        attachmentUrl: (filename) => drive.attachmentUrls.get(filename),
        storeImage: (file) => {
          if (file.size > MAX_IMAGE_BYTES) return Promise.reject(new Error('Too large'));
          return drive.addAttachment(file);
        },
        onNotice: (message) => {
          notice = message;
        },
        onCommentsState: (state) => {
          commentsState = state;
        },
        onLinkShortcut: () => {
          linkEditing = true;
        },
      });
      editor = setup.editor;
      commentsStore = setup.commentsStore;
      if (canEdit && drive.ydoc.getXmlFragment('default').length === 0) editor.commands.focus();
    })();
  });

  onDestroy(() => {
    drive.destroy();
    commentsStore?.destroy();
    editor?.destroy();
  });

  function addComment() {
    if (!editor || !commentsStore || !userNpub) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    if (!selectedText.trim()) return;
    pendingCommentSelection = { from, to, text: selectedText };
    showAddCommentModal = true;
  }

  function handleAddCommentSubmit(commentText: string) {
    if (!editor || !commentsStore || !userNpub || !pendingCommentSelection) return;
    const { from, to, text } = pendingCommentSelection;
    const threadId = commentsStore.createThread(text, commentText, userNpub);
    editor.chain().focus().setTextSelection({ from, to }).setComment(threadId).run();
    commentsStore.setPanelOpen(true);
    commentsStore.setActiveThread(threadId);
    showAddCommentModal = false;
    pendingCommentSelection = null;
  }

  function handleAddCommentCancel() {
    showAddCommentModal = false;
    pendingCommentSelection = null;
    editor?.chain().focus().run();
  }

  function handleCommentThreadClick(threadId: string) {
    if (!editor) return;
    let found = false;
    editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      const marked = node.marks.some(mark => mark.type.name === 'comment' && mark.attrs.commentId === threadId);
      if (!marked) return undefined;
      editor?.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).scrollIntoView().run();
      found = true;
      return false;
    });
  }

  function handleDeleteThread(threadId: string) {
    editor?.chain().removeCommentById(threadId).run();
  }

  function handleEditorClick(event: MouseEvent) {
    const highlight = (event.target as HTMLElement).closest('.comment-highlight');
    const commentId = highlight?.getAttribute('data-comment-id');
    if (commentId && commentsStore) {
      commentsStore.setPanelOpen(true);
      commentsStore.setActiveThread(commentId);
    }
  }

  $effect(() => {
    const current = editor;
    if (!current) return;
    const updateSelection = () => {
      const { from, to } = current.state.selection;
      hasTextSelection = from !== to;
    };
    current.on('selectionUpdate', updateSelection);
    return () => {
      current.off('selectionUpdate', updateSelection);
    };
  });
</script>

<YjsDocumentShell
  bind:editorElement
  bind:linkEditing
  {drive}
  {notice}
  {editor}
  {hasTextSelection}
  {userNpub}
  {commentsState}
  {commentsStore}
  {showAddCommentModal}
  pendingCommentText={pendingCommentSelection?.text || ''}
  onAddComment={addComment}
  onToggleCommentsPanel={() => commentsStore?.togglePanel()}
  onEditorClick={handleEditorClick}
  onClickThread={handleCommentThreadClick}
  onDeleteThread={handleDeleteThread}
  onImageFile={handleImageUpload}
  onAddCommentSubmit={handleAddCommentSubmit}
  onAddCommentCancel={handleAddCommentCancel}
/>
