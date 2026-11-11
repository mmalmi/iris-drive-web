<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import * as Y from 'yjs';
  import { LinkType, nhashEncode, toHex } from '@hashtree/core';
  import type { CID, TreeEntry } from '@hashtree/core';
  import { getTree } from '../../store';
  import { routeStore, getTreeRootSync, treeRootStore } from '../../stores';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import { nostrStore, saveOwnTreeRoot } from '../../nostr';
  import { deleteCurrentFolder } from '../../actions';
  import type { CommentsStore } from '../../lib/comments';
  import type { CommentsState } from '../../lib/comments/types';
  import YjsDocumentShell from './YjsDocumentShell.svelte';
  import {
    ATTACHMENTS_DIRECTORY,
    ATTACHMENT_SCHEME,
    DocumentSession,
    STORED_ORIGIN,
    attachmentFilename,
    connectDocumentTabs,
    createYjsTiptapEditor,
    generateImageFilename,
    documentWriteScope,
    type DocumentChange,
  } from '../../lib/yjs';
  import { DOCUMENT_TITLE_PARAM, documentTitle } from '../../lib/documentNames';
  import { getCidFileUrl } from '../../lib/mediaUrl';
  import { removeOwnDirectoryForDriveRoute, setEntryForDriveRoute } from '../../drive/profileDriveRouteEntry';

  // Edits are stored after a short pause, and at least this often while typing without one.
  const SAVE_IDLE_MS = 800;
  const SAVE_MAX_WAIT_MS = 4000;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  // About half a minute of looking for the document before saying it is not there.
  const MAX_MISSED_LOADS = 60;

  type SaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error' | 'other-tab';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  let route = $derived($routeStore);
  let userNpub = $derived($nostrStore.npub);
  let writeScope = $derived(documentWriteScope(route.npub, userNpub, $nostrStore));
  let canEdit = $derived(!!writeScope && !!route.treeName && !route.isPermalink);
  let title = $derived(documentTitle(dirName));
  let backHref = $derived.by(() => {
    if (!route.npub || !route.treeName) return '#/';
    const parent = route.path.slice(0, -1).map(encodeURIComponent).join('/');
    const key = route.params.get('k');
    return `#/${route.npub}/${encodeURIComponent(route.treeName)}${parent ? `/${parent}` : ''}${key ? `?k=${key}` : ''}`;
  });

  let editorElement: HTMLElement | undefined = $state();
  let editor: Editor | undefined = $state();
  let loading = $state(true);
  let saveStatus = $state<SaveStatus>('idle');
  let commentsStore: CommentsStore | undefined = $state();
  let commentsState = $state<CommentsState>({ threads: new Map(), activeThreadId: null, panelOpen: false });
  let hasTextSelection = $state(false);
  let showAddCommentModal = $state(false);
  let pendingCommentSelection = $state<{ from: number; to: number; text: string } | null>(null);
  let notice = $state('');
  let missing = $state(false);

  let ydoc: Y.Doc | undefined;
  let session: DocumentSession | undefined;
  let disconnectTabs: (() => void) | undefined;
  let isSaver = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let firstUnsavedAt = 0;
  let failedSaves = 0;
  let loadQueue: Promise<unknown> = Promise.resolve();
  let retryLoadTimer: ReturnType<typeof setTimeout> | undefined;
  let missedLoads = 0;
  let documentFound: () => void = () => {};
  let documentCid: CID | null = null;
  const attachmentUrls: Record<string, string> = {};
  // The route can change before this component is torn down; the document's place does not.
  let documentPath: string[] = [];
  let destroyed = false;

  function sameCid(left: CID | null, right: CID | null): boolean {
    if (!left || !right) return left === right;
    return toHex(left.hash) === toHex(right.hash)
      && (left.key ? toHex(left.key) : '') === (right.key ? toHex(right.key) : '');
  }

  /**
   * Where this document lives, fixed when it is opened. A save can finish
   * after the user has moved to another page, and must still land here.
   */
  let opened: { npub: string; treeName: string; path: string[]; scope: string; pubkey: string } | null = null;

  /** Whether the account that opened the document can still write to it. */
  function canWriteOpened(): boolean {
    const state = nostrStore.getState();
    return !!opened && state.pubkey === opened.pubkey
      && documentWriteScope(opened.npub, state.npub, state) === opened.scope;
  }

  /** Stores document files in the Drive as one root update. */
  async function commitChange(change: DocumentChange): Promise<void> {
    if (!opened || !canWriteOpened()) throw new Error('This document cannot be edited here');
    const { scope, treeName, path: documentPath } = opened;
    const target = { npub: opened.npub, treeName };
    const tree = getTree();
    const files = await Promise.all(change.writes.map(async write => ({
      path: write.path,
      ...(await tree.putFile(write.data)),
    })));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const base = getTreeRootSync(scope, treeName);
      let root = base ?? (await tree.putDirectory([])).cid;
      for (const file of files) {
        root = await setEntryForDriveRoute(
          tree,
          root,
          [...documentPath, ...file.path.slice(0, -1)],
          file.path[file.path.length - 1],
          { cid: file.cid, size: file.size, type: LinkType.Blob },
          target,
          nostrStore.getState(),
        );
      }
      for (const directory of change.removeDirectories) {
        root = await removeOwnDirectoryForDriveRoute(
          tree, root, [...documentPath, ...directory], target, nostrStore.getState(),
        );
      }
      if (!canWriteOpened()) throw new Error('The account changed before the document could be saved');
      // Another write landed while this one was prepared: redo it on the newer Drive.
      if (!sameCid(getTreeRootSync(scope, treeName), base)) continue;
      if (!saveOwnTreeRoot(scope, treeName, root)) throw new Error('This document cannot be edited here');
      return;
    }
    throw new Error('The Drive kept changing while saving');
  }

  /**
   * Applies what the Drive now holds for this document. Loads run one after
   * another. Right after a page load the Drive may not be readable yet, so a
   * folder that cannot be found is looked for again.
   */
  function loadStored(root: CID | null): Promise<unknown> {
    const path = documentPath;
    if (retryLoadTimer) clearTimeout(retryLoadTimer);
    retryLoadTimer = undefined;
    loadQueue = loadQueue.then(async () => {
      if (!session || destroyed) return;
      let found = false;
      try {
        const folder = root ? await getTree().resolvePath(root, path) : null;
        if (folder?.type === LinkType.Dir) {
          const list: TreeEntry[] = await getTree().listDirectory(folder.cid);
          await session.load(list);
          await rememberAttachments(list);
          documentCid = folder.cid;
          found = true;
        }
      } catch (error) {
        console.error('[Document] Could not read stored updates:', error);
      }
      if (destroyed) return;
      if (found) {
        missedLoads = 0;
        documentFound();
      } else if (missedLoads < MAX_MISSED_LOADS) {
        missedLoads += 1;
        retryLoadTimer = setTimeout(() => void loadStored($treeRootStore), 500);
      } else if (loading) {
        missing = true;
      }
    });
    return loadQueue;
  }

  $effect(() => {
    const root = $treeRootStore;
    if (session) void loadStored(root);
  });

  $effect(() => {
    if (editor && editor.isEditable !== canEdit) editor.setEditable(canEdit);
  });

  function scheduleSave(): void {
    if (!isCurrentSaver()) return;
    const now = Date.now();
    firstUnsavedAt ||= now;
    saveStatus = 'unsaved';
    if (saveTimer) clearTimeout(saveTimer);
    const wait = Math.max(0, Math.min(SAVE_IDLE_MS, firstUnsavedAt + SAVE_MAX_WAIT_MS - now));
    saveTimer = setTimeout(() => void saveNow(), wait);
  }

  async function saveNow(): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    firstUnsavedAt = 0;
    if (!session || !isCurrentSaver()) return;
    if (!session.dirty) {
      if (saveStatus === 'unsaved') saveStatus = 'saved';
      return;
    }
    saveStatus = 'saving';
    try {
      await session.save();
      failedSaves = 0;
      if (destroyed) return;
      if (session.dirty) scheduleSave();
      else saveStatus = 'saved';
    } catch (error) {
      if (destroyed) return;
      console.error('[Document] Save failed:', error);
      failedSaves += 1;
      saveStatus = 'error';
      saveTimer = setTimeout(() => void saveNow(), Math.min(30_000, 1000 * 2 ** failedSaves));
    }
  }

  /** Leaving the page must not wait for the pause that normally precedes a save. */
  function saveBeforeLeaving(): void {
    if (session?.dirty) void saveNow();
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'hidden') saveBeforeLeaving();
  }

  /** Attachments are addressed by content, so the same link works in a Drive and in a snapshot. */
  async function rememberAttachments(list: TreeEntry[]): Promise<void> {
    const folder = list.find(entry => entry.name === ATTACHMENTS_DIRECTORY && entry.type === LinkType.Dir);
    if (!folder) return;
    for (const entry of await getTree().listDirectory(folder.cid)) {
      if (entry.type !== LinkType.Dir) attachmentUrls[entry.name] = getCidFileUrl(entry.cid, entry.name);
    }
    for (const img of editorElement?.querySelectorAll('img') ?? []) resolveImageSrc(img);
  }

  function isCurrentSaver(): boolean {
    return isSaver && !!opened && canWriteOpened();
  }

  /** Shows an attachment once this browser knows where it is; until then the image stays empty. */
  function resolveImageSrc(img: HTMLImageElement): void {
    const filename = attachmentFilename(img.getAttribute('src')) ?? img.dataset.attachment ?? null;
    if (!filename) return;
    img.dataset.attachment = filename;
    const url = attachmentUrls[filename];
    if (url && img.getAttribute('src') !== url) img.src = url;
  }

  async function handleImageUpload(file: File): Promise<void> {
    if (!canEdit || !editor || !file.type.startsWith('image/')) return;
    if (file.size > MAX_IMAGE_BYTES) {
      notice = 'Images can be up to 20 MB.';
      return;
    }
    notice = '';
    const filename = generateImageFilename(file);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await commitChange({ writes: [{ path: [ATTACHMENTS_DIRECTORY, filename], data }], removeDirectories: [] });
      attachmentUrls[filename] = URL.createObjectURL(file);
      editor.chain().focus().setImage({ src: `${ATTACHMENT_SCHEME}${filename}`, alt: file.name }).run();
    } catch (error) {
      console.error('[Document] Could not add image:', error);
      notice = 'Could not add the image.';
    }
  }

  /** Shares a read-only copy of the document as it is stored now. */
  async function handleShare(): Promise<void> {
    if (session?.dirty) await saveNow();
    await loadStored($treeRootStore);
    if (!documentCid) return;
    const snapshot = nhashEncode({
      hash: toHex(documentCid.hash),
      decryptKey: documentCid.key ? toHex(documentCid.key) : undefined,
    });
    const link = `${window.location.origin}${window.location.pathname}#/${snapshot}?${DOCUMENT_TITLE_PARAM}=${encodeURIComponent(title)}`;
    openShareModal(link);
  }

  async function handleDelete(): Promise<void> {
    if (!confirm(`Delete "${title}"?`)) return;
    if (saveTimer) clearTimeout(saveTimer);
    isSaver = false;
    session?.setSaver(false);
    await deleteCurrentFolder();
  }

  onMount(() => {
    const doc = new Y.Doc();
    ydoc = doc;
    documentPath = [...route.path];
    const pubkey = $nostrStore.pubkey;
    if (canEdit && pubkey && route.npub && route.treeName && writeScope) {
      opened = {
        npub: route.npub,
        treeName: route.treeName,
        path: [...route.path],
        scope: writeScope,
        pubkey,
      };
    }
    const activeSession = new DocumentSession({
      ydoc: doc,
      tree: getTree(),
      // Each device has its own key, so its folder is its alone.
      writerId: (pubkey ?? 'viewer').slice(0, 12),
      commit: commitChange,
    });
    // Until this tab is known to be the one that saves, it only shows edits.
    activeSession.setSaver(false);
    session = activeSession;
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== STORED_ORIGIN) scheduleSave();
    });

    if (opened) {
      disconnectTabs = connectDocumentTabs({
        key: `${opened.npub}/${opened.treeName}/${opened.path.join('/')}`,
        ydoc: doc,
        onSaver: () => {
          isSaver = true;
          activeSession.setSaver(true);
          if (activeSession.dirty) scheduleSave();
          else if (saveStatus === 'other-tab') saveStatus = 'idle';
        },
      });
      if (!isSaver) saveStatus = 'other-tab';
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', saveBeforeLeaving);

    void (async () => {
      // The editor opens once the document has been read, never on a blank page that is still loading.
      await new Promise<void>((resolve) => {
        documentFound = resolve;
        void loadStored($treeRootStore);
      });
      if (destroyed) return;
      missing = false;
      loading = false;
      await tick();
      if (destroyed || !editorElement) return;
      const setup = createYjsTiptapEditor({
        element: editorElement,
        ydoc: doc,
        canEdit,
        handleImageUpload,
        resolveImageSrc,
        onCommentsState: (state) => {
          commentsState = state;
        },
      });
      editor = setup.editor;
      commentsStore = setup.commentsStore;
      if (canEdit && doc.getXmlFragment('default').length === 0) editor.commands.focus();
    })();
  });

  onDestroy(() => {
    saveBeforeLeaving();
    destroyed = true;
    if (saveTimer) clearTimeout(saveTimer);
    if (retryLoadTimer) clearTimeout(retryLoadTimer);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', saveBeforeLeaving);
    disconnectTabs?.();
    commentsStore?.destroy();
    editor?.destroy();
    // The last save may still be reading the document.
    const closing = { session, ydoc };
    void loadQueue.then(() => session?.save()).catch(() => {}).finally(() => {
      closing.session?.destroy();
      closing.ydoc?.destroy();
    });
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
  {title}
  {backHref}
  {canEdit}
  {saveStatus}
  {notice}
  {editor}
  {loading}
  {missing}
  {hasTextSelection}
  {userNpub}
  {commentsState}
  {commentsStore}
  {showAddCommentModal}
  pendingCommentText={pendingCommentSelection?.text || ''}
  onShare={handleShare}
  onDelete={handleDelete}
  onAddComment={addComment}
  onToggleCommentsPanel={() => commentsStore?.togglePanel()}
  onEditorClick={handleEditorClick}
  onClickThread={handleCommentThreadClick}
  onDeleteThread={handleDeleteThread}
  onImageFile={handleImageUpload}
  onAddCommentSubmit={handleAddCommentSubmit}
  onAddCommentCancel={handleAddCommentCancel}
/>
