<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import * as Y from 'yjs';
  import { toHex, LinkType } from '@hashtree/core';
  import type { CID, TreeEntry, TreeVisibility } from '@hashtree/core';
  import { getTree } from '../../store';
  import { routeStore, createTreesStore, getTreeRootSync } from '../../stores';
  import { open as openForkModal } from '../Modals/ForkModal.svelte';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import { open as openCollaboratorsModal } from '../Modals/CollaboratorsModal.svelte';
  import { open as openBlossomPushModal } from '../Modals/BlossomPushModal.svelte';
  import { autosaveIfOwn, nostrStore, npubToPubkey, deleteTree } from '../../nostr';
  import { updateLocalRootCacheHex } from '../../treeRootCache';
  import { getCurrentRootCid, deleteCurrentFolder } from '../../actions';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import YjsDocumentShell from './YjsDocumentShell.svelte';
  import {
    saveImageToTree,
    generateImageFilename,
    loadDeltasFromEntries,
    loadCollaboratorDeltas,
    setupCollaboratorSubscriptions,
    createYjsTiptapEditor,
  } from '../../lib/yjs';
  import { createThrottledCapture, getThumbnailFilename } from '../../lib/yjs/thumbnail';
  import { getNpubFileUrl } from '../../lib/mediaUrl';
  interface Props {
    dirCid: CID;
    dirName: string;
    entries: TreeEntry[];
  }
  let { dirCid, dirName, entries }: Props = $props();
  let route = $derived($routeStore);
  let userNpub = $derived($nostrStore.npub);
  let viewedNpub = $derived(route.npub);
  let editorElement: HTMLElement | undefined = $state();
  let editor: Editor | undefined = $state();
  let ydoc: Y.Doc | undefined = $state();
  let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let lastSaved = $state<Date | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let loading = $state(true);
  const captureThrottled = createThrottledCapture(30000);
  if (typeof window !== 'undefined') {
    window.__thumbnailCaptureReset = () => captureThrottled.reset();
  }
  let commentsStore: CommentsStore | undefined = $state();
  let commentsState = $state<CommentsState>({ threads: new Map(), activeThreadId: null, panelOpen: false });
  let hasTextSelection = $state(false);
  let showAddCommentModal = $state(false);
  let pendingCommentSelection = $state<{ from: number; to: number; text: string } | null>(null);
  let collaborators = $state<string[]>([]);
  let isOwnTree = $derived(!viewedNpub || viewedNpub === userNpub);
  let isEditor = $derived(userNpub ? collaborators.includes(userNpub) : false);
  let canEdit = $derived(isOwnTree || isEditor);
  let ownerNpub = $derived(viewedNpub || userNpub);
  let ownerPubkey = $derived(ownerNpub ? npubToPubkey(ownerNpub) : null);
  let targetNpub = $derived(viewedNpub || userNpub);
  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<Array<{ name: string; visibility?: TreeVisibility }>>([]);
  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });
  let currentTree = $derived(route.treeName ? trees.find(t => t.name === route.treeName) : null);
  let visibility = $derived(currentTree?.visibility || 'public');
  let yjsEntry = $derived(entries.find(e => e.name === '.yjs'));
  let prevCollaboratorsKey = '';
  let prevYjsEntryCid = '';
  let prevDirCid = '';
  $effect(() => {
    const cidKey = yjsEntry
      ? `${toHex(yjsEntry.cid.hash)}:${yjsEntry.cid.key ? toHex(yjsEntry.cid.key) : ''}`
      : '';
    if (!cidKey || cidKey === prevYjsEntryCid) return;
    prevYjsEntryCid = cidKey;
    void loadEditors();
  });
  $effect(() => {
    const cidKey = dirCid
      ? `${toHex(dirCid.hash)}:${dirCid.key ? toHex(dirCid.key) : ''}`
      : '';
    if (!cidKey || cidKey === prevDirCid) return;
    prevDirCid = cidKey;
    void loadEditors();
  });
  $effect(() => {
    const currentKey = collaborators.join(',');
    if (currentKey !== prevCollaboratorsKey && ydoc && collaborators.length > 0) {
      prevCollaboratorsKey = currentKey;
      setupCollabSubscriptions(collaborators);
    }
  });
  let prevEntriesCids = '';
  $effect(() => {
    const deltasEntry = entries.find(e => e.name === 'deltas' && e.type === LinkType.Dir);
    const stateEntry = entries.find(e => e.name === 'state.yjs' && e.type !== LinkType.Dir);
    const currentCids = [
      deltasEntry ? toHex(deltasEntry.cid.hash) : '',
      stateEntry ? toHex(stateEntry.cid.hash) : ''
    ].join(',');
    if (currentCids !== prevEntriesCids && ydoc && prevEntriesCids !== '') {
      prevEntriesCids = currentCids;
      loadDeltasFromEntries(entries).then(deltas => {
        for (const delta of deltas) {
          Y.applyUpdate(ydoc!, delta, 'remote');
        }
      });
    } else if (prevEntriesCids === '') {
      prevEntriesCids = currentCids;
    }
  });
  $effect(() => {
    if (editor && editor.isEditable !== canEdit) {
      editor.setEditable(canEdit);
    }
  });
  async function saveImage(data: Uint8Array, filename: string): Promise<string | null> {
    if (!userNpub || !route.treeName) {
      console.warn('[YjsDoc] Missing userNpub or treeName, cannot save image');
      return null;
    }
    return saveImageToTree(
      data,
      filename,
      route.path,
      userNpub,
      route.treeName,
      isOwnTree,
      isOwnTree ? undefined : visibility,
    );
  }
  async function handleImageUpload(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const filename = generateImageFilename(file);
    const savedFilename = await saveImage(data, filename);
    if (savedFilename && editor) {
      const uploaderNpub = userNpub;
      editor.chain().focus().setImage({ src: `attachments:${uploaderNpub}/${savedFilename}` }).run();
      scheduleSave();
    }
  }
  let cleanupCollabSubscriptions: (() => void) | null = null;
  function setupCollabSubscriptions(collaboratorNpubs: string[]) {
    if (cleanupCollabSubscriptions) {
      cleanupCollabSubscriptions();
    }
    if (!ydoc) return;
    cleanupCollabSubscriptions = setupCollaboratorSubscriptions(
      collaboratorNpubs,
      route.treeName,
      route.path,
      viewedNpub,
      userNpub,
      ydoc,
      () => collaborators,
      (npubs) => { collaborators = npubs; }
    );
  }
  async function saveStateSnapshot(): Promise<void> {
    const tree = getTree();
    if (!ydoc || !userNpub || !route.treeName) {
      console.warn('[YjsDoc] Missing ydoc, userNpub, or treeName, cannot save');
      return;
    }
    let rootCid = getTreeRootSync(userNpub, route.treeName);
    if (!rootCid) {
      const { cid: emptyDirCid } = await tree.putDirectory([]);
      rootCid = emptyDirCid;
    }
    saveStatus = 'saving';
    try {
      const stateUpdate = Y.encodeStateAsUpdate(ydoc);
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).slice(2, 6);
      const deltaName = `${timestamp}-${random}`;
      const currentPath = route.path;
      const deltasPath = [...currentPath, 'deltas'];
      for (let i = 0; i < currentPath.length; i++) {
        const parentPath = currentPath.slice(0, i);
        const dirName = currentPath[i];
        const fullPath = currentPath.slice(0, i + 1).join('/');
        const pathExists = await tree.resolvePath(rootCid, fullPath);
        if (!pathExists) {
          const { cid: emptyDirCid } = await tree.putDirectory([]);
          rootCid = await tree.setEntry(rootCid, parentPath, dirName, emptyDirCid, 0, LinkType.Dir);
        }
      }
      const docResult = await tree.resolvePath(rootCid, currentPath.join('/'));
      if (docResult) {
        const docEntries = await tree.listDirectory(docResult.cid);
        const hasYjsFile = docEntries.some(e => e.name === '.yjs' && e.type !== LinkType.Dir);
        if (!hasYjsFile) {
          const yjsContent = collaborators.join('\n') + '\n';
          const yjsData = new TextEncoder().encode(yjsContent);
          const { cid: yjsCid, size: yjsSize } = await tree.putFile(yjsData);
          rootCid = await tree.setEntry(rootCid, currentPath, '.yjs', yjsCid, yjsSize, LinkType.Blob);
        }
      }
      const deltasResult = await tree.resolvePath(rootCid, deltasPath.join('/'));
      if (!deltasResult) {
        const { cid: emptyDirCid } = await tree.putDirectory([]);
        rootCid = await tree.setEntry(rootCid, currentPath, 'deltas', emptyDirCid, 0, LinkType.Dir);
      }
      const { cid: deltaCid, size: deltaSize } = await tree.putFile(stateUpdate);
      const newRootCid = await tree.setEntry(
        rootCid,
        deltasPath,
        deltaName,
        deltaCid,
        deltaSize,
        LinkType.Blob
      );
      if (isOwnTree) {
        autosaveIfOwn(newRootCid);
      } else {
        updateLocalRootCacheHex(
          userNpub,
          route.treeName,
          toHex(newRootCid.hash),
          newRootCid.key ? toHex(newRootCid.key) : undefined,
          visibility,
        );
      }
      saveStatus = 'saved';
      lastSaved = new Date();
      if (editorElement && isOwnTree) {
        captureThumbnail(newRootCid);
      }
    } catch (e) {
      console.error('[YjsDoc] Failed to save state snapshot:', e);
      saveStatus = 'error';
    }
  }
  async function captureThumbnail(currentRootCid: CID) {
    if (!editorElement || !userNpub || !route.treeName) return;
    try {
      const thumbnailData = await captureThrottled(editorElement);
      if (!thumbnailData) return; // Throttled or failed
      const tree = getTree();
      const currentPath = route.path;
      const { cid: thumbCid, size: thumbSize } = await tree.putFile(thumbnailData);
      const newRootCid = await tree.setEntry(
        currentRootCid,
        currentPath,
        getThumbnailFilename(),
        thumbCid,
        thumbSize,
        LinkType.Blob
      );
      autosaveIfOwn(newRootCid);
    } catch {
    }
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveStateSnapshot(), 1000);
  }
  async function loadEditors() {
    try {
      const tree = getTree();
      const docEntries = await tree.listDirectory(dirCid);
      const yjsConfigEntry = docEntries.find(e => e.name === '.yjs' && e.type !== LinkType.Dir);
      if (!yjsConfigEntry) {
        collaborators = [];
        return;
      }
      const data = await tree.readFile(yjsConfigEntry.cid);
      if (data) {
        const text = new TextDecoder().decode(data);
        collaborators = text.split('\n').filter(line => line.trim().startsWith('npub1'));
      } else {
        collaborators = [];
      }
    } catch (e) {
      console.error('[YjsDoc] Failed to load editors:', e);
      collaborators = [];
    }
  }
  async function saveCollaborators(npubs: string[]) {
    const tree = getTree();
    let currentRootCid = getCurrentRootCid();
    if (!currentRootCid) {
      console.warn('[YjsDoc] No rootCid, cannot save editors');
      return;
    }
    try {
      const content = npubs.join('\n') + '\n';
      const data = new TextEncoder().encode(content);
      const { cid: yjsCid, size: yjsSize } = await tree.putFile(data);
      const newRootCid = await tree.setEntry(
        currentRootCid,
        route.path,
        '.yjs',
        yjsCid,
        yjsSize,
        LinkType.Blob
      );
      autosaveIfOwn(newRootCid);
      collaborators = npubs;
    } catch (e) {
      console.error('[YjsDoc] Failed to save editors:', e);
    }
  }
  function handleShare() {
    openShareModal(window.location.href);
  }
  function handlePush() {
    openBlossomPushModal(
      dirCid,
      dirName,
      true,
      route.npub ? (npubToPubkey(route.npub) ?? undefined) : undefined,
      route.treeName ?? undefined,
    );
  }
  function handleFork() {
    if (!dirCid) return;
    openForkModal(dirCid, dirName);
  }
  function handleCollaborators() {
    if (isOwnTree) {
      openCollaboratorsModal({ npubs: collaborators, onSave: saveCollaborators });
    } else {
      openCollaboratorsModal({ npubs: collaborators });
    }
  }
  async function handleDelete() {
    if (confirm(`Delete document "${dirName}" and all its contents?`)) {
      if (route.path.length === 0 && route.treeName) {
        await deleteTree(route.treeName);
        window.location.hash = '/';
      } else {
        deleteCurrentFolder();
      }
    }
  }
  onMount(async () => {
    if (import.meta.env.VITE_TEST_MODE) {
      const testWindow = window as Window & { __reloadYjsEditors?: () => void };
      testWindow.__reloadYjsEditors = () => loadEditors();
    }
    ydoc = new Y.Doc();
    const initPromise = (async () => {
      await loadEditors();
      const localDeltas = await loadDeltasFromEntries(entries);
      for (const delta of localDeltas) {
        Y.applyUpdate(ydoc, delta, 'remote');
      }
      if (collaborators.length > 0) {
        await loadCollaboratorDeltas(collaborators, route.npub, route.path, route.treeName, ydoc);
      }
    })().catch((err) => {
      console.error('[YjsDoc] Init failed:', err);
    });
    loading = false;
    await tick();
    if (!editorElement || !ydoc) return;
    const editorSetup = createYjsTiptapEditor({
      element: editorElement,
      ydoc,
      canEdit,
      handleImageUpload,
      resolveImageSrc,
      scheduleSave,
      onCommentsState: (state) => {
        commentsState = state;
      },
    });
    editor = editorSetup.editor;
    commentsStore = editorSetup.commentsStore;
    if (collaborators.length > 0) {
      setupCollabSubscriptions(collaborators);
    }
    void initPromise;
  });
  function resolveImageSrc(img: HTMLImageElement): void {
    const src = img.getAttribute('src');
    if (!src || !src.startsWith('attachments:')) return;
    const attachmentPath = src.replace('attachments:', '');
    let imageNpub: string;
    let filename: string;
    if (attachmentPath.startsWith('npub1')) {
      const slashIndex = attachmentPath.indexOf('/');
      if (slashIndex > 0) {
        imageNpub = attachmentPath.slice(0, slashIndex);
        filename = attachmentPath.slice(slashIndex + 1);
      } else {
        imageNpub = viewedNpub || userNpub || '';
        filename = attachmentPath;
      }
    } else {
      imageNpub = viewedNpub || userNpub || '';
      filename = attachmentPath;
    }
    const treeName = route.treeName;
    if (!imageNpub || !treeName) {
      img.dataset.pendingResolve = 'true';
      return;
    }
    const pathParts = [...route.path, 'attachments', filename];
    img.src = getNpubFileUrl(imageNpub, treeName, pathParts.join('/'));
  }
  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (cleanupCollabSubscriptions) {
      cleanupCollabSubscriptions();
      cleanupCollabSubscriptions = null;
    }
    commentsStore?.destroy();
    editor?.destroy();
    ydoc?.destroy();
  });
  function addComment() {
    if (!editor || !commentsStore || !userNpub) return;
    const { from, to } = editor.state.selection;
    if (from === to) return; // No selection
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    if (!selectedText.trim()) return;
    pendingCommentSelection = { from, to, text: selectedText };
    showAddCommentModal = true;
  }
  function handleAddCommentSubmit(commentText: string) {
    if (!editor || !commentsStore || !userNpub || !pendingCommentSelection) return;
    const { from, to, text } = pendingCommentSelection;
    const threadId = commentsStore.createThread(text, commentText, userNpub);
    editor.chain()
      .focus()
      .setTextSelection({ from, to })
      .setComment(threadId)
      .run();
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
    const { doc } = editor.state;
    let found = false;
    doc.descendants((node, pos) => {
      if (found) return false;
      const commentMark = node.marks.find(
        mark => mark.type.name === 'comment' && mark.attrs.commentId === threadId
      );
      if (commentMark) {
        editor?.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).run();
        found = true;
        return false;
      }
    });
  }
  function handleDeleteThread(threadId: string) {
    if (!editor) return;
    editor.chain().removeCommentById(threadId).run();
  }
  function handleEditorClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const commentHighlight = target.closest('.comment-highlight');
    if (commentHighlight) {
      const commentId = commentHighlight.getAttribute('data-comment-id');
      if (commentId && commentsStore) {
        commentsStore.setPanelOpen(true);
        commentsStore.setActiveThread(commentId);
      }
    }
  }
  function toggleCommentsPanel() {
    commentsStore?.togglePanel();
  }
  $effect(() => {
    if (!editor) return;
    const updateSelection = () => {
      const { from, to } = editor!.state.selection;
      hasTextSelection = from !== to;
    };
    editor.on('selectionUpdate', updateSelection);
    return () => {
      editor?.off('selectionUpdate', updateSelection);
    };
  });
</script>
<YjsDocumentShell
  bind:editorElement
  {dirName}
  {ownerNpub}
  {ownerPubkey}
  {visibility}
  {canEdit}
  {isOwnTree}
  {isEditor}
  {saveStatus}
  {lastSaved}
  collaboratorsCount={collaborators.length}
  {editor}
  {loading}
  {hasTextSelection}
  {userNpub}
  {commentsState}
  {commentsStore}
  {showAddCommentModal}
  pendingCommentText={pendingCommentSelection?.text || ''}
  onShare={handleShare}
  onPush={handlePush}
  onCollaborators={handleCollaborators}
  onFork={handleFork}
  onDelete={handleDelete}
  onAddComment={addComment}
  onToggleCommentsPanel={toggleCommentsPanel}
  onEditorClick={handleEditorClick}
  onClickThread={handleCommentThreadClick}
  onDeleteThread={handleDeleteThread}
  onImageFile={handleImageUpload}
  onAddCommentSubmit={handleAddCommentSubmit}
  onAddCommentCancel={handleAddCommentCancel}
/>
