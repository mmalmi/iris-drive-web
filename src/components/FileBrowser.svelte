<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { toHex, LinkType, type TreeEntry as FileEntry } from '@hashtree/core';
  import { COPY_NAME_PARAM } from '../lib/shareUrls';
  import { untrack } from 'svelte';
  import { addCopiedEntry, deleteEntry } from '../actions';
  import EmptyFolder from './EmptyFolder.svelte';
  import { cutItems, pastedCut, finishCut } from '../lib/cutClipboard';
  import { open as openRename } from './Modals/RenameModal.svelte';
  import { openNewMenuBeside } from './NewMenu.svelte';
  import { copyEntryLinks, shareEntry } from './entrySharing';
  import { moveSelection } from '../lib/moveEntries';
  import { open as openMove, moveAndTell } from './Modals/MoveModal.svelte';
  import SelectionBar, { deleteChosen } from './SelectionBar.svelte';
  import ListSortHeader from './ListSortHeader.svelte';
  import { loadGridView } from './FolderViewSwitch.svelte';
  import FolderEntries, { verticalGridIndex } from './FolderEntries.svelte';
  import FileEntryLabel from './FileEntryLabel.svelte';
  import SelectionRectangle from './SelectionRectangle.svelte';
  import { ListSelection } from '../lib/listSelection.svelte';
  import { loadSort, sortEntries, type ListSort } from '../lib/fileListSort';
  import { modifiedAt } from '../lib/modifiedAt';
  import { uploadFiles } from '../stores/upload';
  import { recentlyChangedFiles, revealFile } from '../stores/recentlyChanged';
  import { toast } from '../stores/toast';
  import { getNhashFileUrl } from '../lib/mediaUrl';
  import { copiedEntryIn, copiedMessage, copyEntry, copyKind, downloadDragData, entryLink, freeName, isOutsideDrag, noteCopied, pastedIntoFolder } from '../lib/driveClipboard';
  import { addDropped } from '../lib/folderDrop';
  import { nostrStore } from '../nostr';
  import FolderHeader from './FolderHeader.svelte';
  import EntryMenu, { type EntryMenuRequest } from './EntryMenu.svelte';
  import { longPress } from '../lib/longPress';
  import { createItemAccessLookup } from '../drive/itemAccess';
  import { linkShares } from '../drive/linkShares';
  import ProtectedTreeNotice from './ProtectedTreeNotice.svelte';
  import { treeRootStore, routeStore, createTreesStore, type TreeEntry, currentDirCidStore, isViewingFileStore, resolvingPathStore, directoryEntriesStore, permalinkSnapshotStore } from '../stores';
  import { buildPathHref } from './fileBrowserHrefs';
  import { activeShareScope, shareLocation } from '../drive/shareScope';
  import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
  import { isNostrIdentityId } from '../utils/route';

  import { fileIcon } from '../lib/fileIcon';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';

  const uid = $props.id();

  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let userNpub = $derived($nostrStore.npub);
  let selectedTree = $derived($nostrStore.selectedTree);
  let route = $derived($routeStore);
  let permalinkSnapshot = $derived($permalinkSnapshotStore);
  let rootCid = $derived($treeRootStore);
  let currentDirCid = $derived($currentDirCidStore);
  let recentlyChanged = $derived($recentlyChangedFiles);

  let currentNpub = $derived(route.npub ?? permalinkSnapshot.snapshot?.npub ?? null);
  let currentTreeName = $derived(route.treeName ?? permalinkSnapshot.snapshot?.treeName ?? null);
  let isSnapshotPermalink = $derived(route.params.get('snapshot') === '1' && !!permalinkSnapshot.snapshot);
  let urlPath = $derived(route.path);
  let lastSegment = $derived(urlPath.length > 0 ? urlPath[urlPath.length - 1] : null);
  let isViewingFile = $derived($isViewingFileStore);
  let resolvingPath = $derived($resolvingPathStore);
  let dirEntries = $derived($directoryEntriesStore);
  const folderKey = (path: string[]) => JSON.stringify([
    $nostrStore.pubkey, route.npub ?? (route.cid && toHex(route.cid.hash)), route.treeName,
    route.params.get('k'), route.cid?.key && toHex(route.cid.key), ...path,
  ]);
  /** The folder whose rows are shown, once its address has resolved. */
  let shownFolder = $state<string | null>(null);
  /** A file of that folder is being opened: the list knows before its address has resolved, so nothing moves. */
  let opensFile = $derived(
    resolvingPath && urlPath.length > 0 && shownFolder === folderKey(urlPath.slice(0, -1))
      && dirEntries.entries.some((entry) => entry.name === lastSegment && entry.type !== LinkType.Dir),
  );
  let currentPath = $derived(isViewingFile || opensFile ? urlPath.slice(0, -1) : urlPath);
  let rootHash = $derived(rootCid?.hash ?? null);
  let linkKey = $derived(route.params.get('k'));

  let inTreeView = $derived(!!currentTreeName || !!rootHash);
  let viewedNpub = $derived(currentNpub);
  let viewedNostrIdentityId = $derived(viewedNpub && isNostrIdentityId(viewedNpub) ? viewedNpub : null);
  let knownShare = $derived($acceptedShares.find((record) => record.share_id === viewedNpub));
  let shareRecord = $derived(activeShareScope(viewedNpub, $nostrStore, $acceptedShares)?.record);
  let sharedFolder = $derived(shareRecord?.folder);
  /** What a shared folder sits in: My Drive for one shared from it, otherwise Shared with me. */
  let shareAbove = $derived(shareRecord ? shareLocation(shareRecord) : []);
  let isOwnDriveProfile = $derived(isEditableDriveRouteScope(viewedNpub, $nostrStore, $acceptedShares));
  let isOwnTrees = $derived(!viewedNpub || viewedNpub === userNpub || isOwnDriveProfile);
  // The person's own Drive is called My Drive everywhere; "main" is only its address.
  let isMyDrive = $derived(
    !!viewedNpub && currentTreeName === 'main' && !route.isPermalink
      && viewedNpub === activeNostrIdentityRootScope($nostrStore),
  );
  /** A read-only copy of a folder has no name of its own; its link carries the folder's. */
  let copyName = $derived(route.isPermalink ? route.params.get(COPY_NAME_PARAM) : null);
  let rootName = $derived(isMyDrive ? 'My Drive' : sharedFolder?.display_name || currentTreeName || copyName);
  let canEdit = $derived(isLoggedIn && !route.isPermalink && isOwnTrees);

  let missingDecryptionKey = $derived(!rootCid?.key);

  let targetNpub = $derived(viewedNpub || userNpub);

  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $state<TreeEntry[]>([]);

  let currentTreeFromList = $derived.by(() => {
    if (!currentTreeName) return null;
    return trees.find(t => t.name === currentTreeName) || null;
  });

  let effectiveTree = $derived(isOwnTrees ? selectedTree : currentTreeFromList);

  let currentTreeVisibility = $derived(effectiveTree?.visibility ?? 'public');

  /** Who can open the item at a path of the place being browsed. */
  let accessAt = $derived(
    route.isPermalink
      ? () => null
      : createItemAccessLookup({
        scope: viewedNpub,
        treeName: currentTreeName,
        profileId: activeNostrIdentityRootScope($nostrStore),
        appKeyPubkey: $nostrStore.pubkey,
        records: $acceptedShares,
        linkShares: $linkShares,
        treeVisibility: effectiveTree?.visibility,
      }),
  );
  let currentAccess = $derived(accessAt(currentPath));

  let isProtectedTreeWithoutAccess = $derived(
    !isOwnTrees &&
    missingDecryptionKey &&
    effectiveTree &&
    (effectiveTree.visibility === 'link-visible' || effectiveTree.visibility === 'private')
  );

  $effect(() => treesStore.subscribe(value => {
    trees = value;
  }));

  /** How the list is sorted, as last chosen on this device. */
  let sort = $state<ListSort>(loadSort());
  let grid = $state(loadGridView());
  let entries = $derived(sortEntries(dirEntries.entries, sort));
  // Treat the store as still loading until its loadedHashKey matches the
  // current directory CID — otherwise stale `entries: []` from a previous
  // navigation can briefly render as an empty folder.
  let currentDirHashKey = $derived(currentDirCid?.hash ? toHex(currentDirCid.hash) : null);
  let entriesAreStale = $derived(
    currentDirHashKey !== null && dirEntries.loadedHashKey !== currentDirHashKey
  );
  let loadingEntries = $derived(dirEntries.loading || entriesAreStale);
  // A new revision of the open folder can update its keyed rows in place.
  // On navigation, wait for the destination before showing any rows.
  let waitingForFolder = $derived(loadingEntries && (
    !dirEntries.loadedHashKey || !entries.length || shownFolder !== folderKey(currentPath)
  ));

  let isDraggingOver = $state(false);
  let fileListRef: HTMLDivElement | undefined = $state();

  /**
   * Adds what is dropped from outside the page: files, folders with all that
   * is in them, or a picture dragged from a web page. Into the open folder,
   * or into `dirName` when dropped onto that folder's row.
   */
  async function handleFileDrop(e: DragEvent, dirName: string | null = null) {
    e.preventDefault();
    isDraggingOver = false;
    dropTargetDir = null;
    if (!canEdit || dragging) return;

    if (!e.dataTransfer) return;
    await addDropped(e.dataTransfer, { currentPath, taken: new Set(entries.map(entry => entry.name)), dirName });
  }

  function handleFileDragOver(e: DragEvent) {
    if (!canEdit || dragging) return;
    if (isOutsideDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      isDraggingOver = true;
    }
  }

  function handleFileDragLeave(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      isDraggingOver = false;
    }
  }

  /** The names of what is being dragged: all that is chosen when a chosen row is dragged. */
  let dragging = $state.raw<{ folder: string; items: ReadonlyMap<string, string> } | null>(null);
  let dropTargetDir = $state<string | null>(null);

  function handleEntryDragStart(e: DragEvent, entry: FileEntry) {
    const data = e.dataTransfer!;
    // A file can be dragged out onto the desktop, read-only or not (Chrome, Edge).
    if (entry.type !== LinkType.Dir) {
      data.setData('DownloadURL', downloadDragData(entry, getNhashFileUrl(entry.cid, entry.name)));
    }
    if (!canEdit) {
      if (entry.type === LinkType.Dir) e.preventDefault();
      else data.effectAllowed = 'copy';
      return;
    }
    dragging = { folder: folderKey(currentPath), items: moveSelection(selection.has(entry.name) ? selectionEntries : [entry]) };
    data.effectAllowed = 'copyMove';
    data.setData('text/plain', [...dragging.items.keys()].join('\n'));
  }

  function handleEntryDragEnd() {
    dragging = null;
    dropTargetDir = null;
  }

  /** Moves what was dragged; what has gone is no longer chosen. */
  async function moveDragged(targetPath: string[]) {
    const source = dragging;
    dragging = null;
    if (!source) return;
    if (source.folder !== folderKey(currentPath)) {
      toast.error('The open folder changed. Select the items again.');
      return;
    }
    await moveAndTell(currentPath, source.items, targetPath);
  }

  function handleDirDragOver(e: DragEvent, dirName: string) {
    if (!canEdit) return;
    if (!dragging) {
      // From the desktop or another page: into this folder.
      if (!isOutsideDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      isDraggingOver = true;
      dropTargetDir = dirName;
      return;
    }
    if (dragging.items.has(dirName)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    dropTargetDir = dirName;
  }

  function handleDirDragLeave() {
    dropTargetDir = null;
  }

  async function handleDirDrop(e: DragEvent, dirName: string) {
    e.preventDefault();
    e.stopPropagation();
    dropTargetDir = null;
    if (!dragging) {
      await handleFileDrop(e, dirName);
      return;
    }

    if (!canEdit || dragging.items.has(dirName)) return;
    await moveDragged([...currentPath, dirName]);
  }

  /** The address of the file or folder at `path` of the place being browsed. */
  function hrefAt(path: string[]): string {
    return buildPathHref({
      path,
      currentNpub,
      currentTreeName,
      rootCid,
      linkKey,
      snapshot: isSnapshotPermalink ? permalinkSnapshot.snapshot : null,
      rootName: copyName,
    });
  }

  const entryHref = (entry: FileEntry) => hrefAt([...currentPath, entry.name]);

  /** Where "up" leads: the folder above, where a shared folder sits, or nowhere from My Drive. */
  let parentHref = $derived.by((): string | null => {
    if (currentPath.length > 0) return hrefAt(currentPath.slice(0, -1));
    if (isMyDrive) return null;
    if (shareAbove.length > 0) return shareAbove.at(-1)!.href;
    return currentNpub ? `#/${currentNpub}` : null;
  });
  /** The folders above the open one, outermost first. */
  let parentCrumbs = $derived.by(() => {
    const crumbs: { name: string; href: string }[] = [...shareAbove];
    if (currentPath.length === 0 || !rootName) return crumbs;
    crumbs.push({ name: rootName, href: hrefAt([]) });
    for (let depth = 1; depth < currentPath.length; depth += 1) {
      crumbs.push({ name: currentPath[depth - 1], href: hrefAt(currentPath.slice(0, depth)) });
    }
    return crumbs;
  });
  let currentDirName = $derived(
    currentPath.length > 0
      ? currentPath[currentPath.length - 1]
      : rootName || (rootCid?.hash ? 'Shared folder' : '')
  );

  /**
   * The file being looked at, the list hidden under it meanwhile. Only a name the list has:
   * while a path resolves, the last part of the address may still be the folder.
   */
  let openFileName = $derived(isViewingFile && entries.some((entry) => entry.name === lastSegment) ? lastSegment : null);

  /** The row the keyboard is on. A plain arrow or click also chooses it; Ctrl/⌘+arrow only moves it. */
  let cursor = $state<string | null>(null);
  let cursorIndex = $derived(entries.findIndex((entry) => entry.name === cursor));

  $effect(() => {
    void [inTreeView, currentTreeName, currentPath.join('/')];
    const timer = setTimeout(() => {
      // Take the keyboard only when nothing else has it. A dialog opened in
      // the meantime (New Document, Rename, …) keeps it: taking it there sent
      // the typed name and Enter to the list, and nothing was created.
      const active = document.activeElement;
      if (active && active !== document.body && !fileListRef?.contains(active)) return;
      fileListRef?.focus();
    }, 50);
    return () => clearTimeout(timer);
  });

  /** Whether a clipboard event belongs to something else: a field, an editor or a dialog. */
  function belongsElsewhere(event: ClipboardEvent): boolean {
    if (event.defaultPrevented) return true;
    const target = event.target instanceof Element ? event.target : null;
    const rowCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox' && fileListRef?.contains(target);
    if (!rowCheckbox && target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return true;
    // The app's dialogs cover the page with a fixed layer.
    return !!document.querySelector('dialog[open], [aria-modal="true"], .fixed.inset-0');
  }

  /** The entry a copy, Enter or the menu key is about: the one the keyboard is on, or the only one chosen. */
  function chosenEntry(): FileEntry | null {
    const focused = document.activeElement;
    const row = focused && fileListRef?.contains(focused) ? focused.closest('[data-entry-name]') : null;
    const name = row?.getAttribute('data-entry-name');
    if (name) return entries.find(entry => entry.name === name) ?? null;
    return entries[cursorIndex] ?? (selectionEntries.length === 1 ? selectionEntries[0] : null);
  }

  function open(entry: FileEntry) {
    window.location.hash = entryHref(entry).slice(1);
  }

  // Pasting into the folder: files copied in Finder or Explorer, a screenshot
  // or copied picture, or plain text kept as a text file.
  $effect(() => {
    if (!inTreeView || !canEdit) return;
    const onCut = (event: ClipboardEvent) => {
      if (belongsElsewhere(event) || isViewingFile || resolvingPath || loadingEntries || !window.getSelection()?.isCollapsed) return;
      const account = $nostrStore.pubkey;
      if (!canEdit || !account || !route.npub || !route.treeName || !event.clipboardData) return;
      const picked = chosenEntry();
      const items = selectionEntries.length ? selectionEntries : picked ? [picked] : [];
      if (!items.length) return;
      event.preventDefault();
      cutItems(event.clipboardData, account, route.npub, route.treeName, currentPath, items);
      toast.success(items.length === 1 ? `Cut “${documentTitle(items[0].name)}”` : `Cut ${items.length} items`, 2500);
    };
    const onPaste = (event: ClipboardEvent) => {
      // Right after moving to another folder, which folder is open is still being worked out.
      if (belongsElsewhere(event) || resolvingPath || loadingEntries || isViewingFile) return;
      const cut = pastedCut(event.clipboardData);
      if (cut) {
        event.preventDefault();
        if (cut === 'expired') { toast.error('Select the items and cut them again'); return; }
        if (cut.account !== $nostrStore.pubkey || cut.scope !== route.npub || cut.tree !== route.treeName) {
          toast.error('Paste into a folder in the same Drive');
          return;
        }
        const expected = new Map(cut.entries.map(entry => [entry.name, entry.hash]));
        void moveAndTell(cut.path, expected, currentPath)
          .then(moved => { if (moved) finishCut(cut.token); });
        return;
      }
      // A file copied here comes back as itself, not as its picture, text or link.
      const copied = copiedEntryIn(event.clipboardData);
      if (copied) {
        event.preventDefault();
        const name = freeName(copied.name, new Set(entries.map(entry => entry.name)));
        void addCopiedEntry(name, copied).then(
          () => toast.success(`Pasted ${name}`),
          () => toast.error(`Could not paste ${copied.name}`),
        );
        return;
      }
      const pasted = pastedIntoFolder(event.clipboardData, new Set(entries.map(entry => entry.name)));
      if (!pasted) return;
      event.preventDefault();
      const many = pasted.files.length > 1;
      void uploadFiles(pasted.files, { quiet: true }).then(() => {
        toast.success(many ? `Pasted ${pasted.summary}` : `Saved as ${pasted.summary}`);
      }, () => toast.error('Could not save what was pasted.'));
    };
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  });

  // Copying a file for other apps: a picture as a picture, a text file as its text, anything else as a link.
  $effect(() => {
    if (!inTreeView) return;
    const onCopy = (event: ClipboardEvent) => {
      if (belongsElsewhere(event) || !window.getSelection()?.isCollapsed) return;
      const entry = chosenEntry();
      if (!entry) return;
      event.preventDefault();
      if (copyKind(entry) === 'link' && event.clipboardData) {
        const link = entryLink(entry);
        event.clipboardData.setData('text/plain', link);
        noteCopied(entry, { text: link });
        toast.success(copiedMessage('link', entry.name), 2500);
        return;
      }
      copyEntry(entry).then(
        kind => toast.success(copiedMessage(kind, entry.name), 2500),
        (error: unknown) => {
          console.warn('[Drive] Could not copy:', error);
          toast.error(`Could not copy ${entry.name}`);
        },
      );
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  });

  /** The menu of one file or folder, from its ⋮ button, a right click or the menu key. */
  let entryMenu = $state<EntryMenuRequest | null>(null);
  /** A mouse drags rows; a finger's long press chooses them instead. */
  const finePointer = window.matchMedia('(pointer: fine)').matches;

  function rowElement(name: string): HTMLElement | null {
    return fileListRef?.querySelector<HTMLElement>(`[data-entry-name="${CSS.escape(name)}"]`) ?? null;
  }

  function openEntryMenu(entry: FileEntry, at: { x: number; y: number; opener: HTMLElement | null }) {
    entryMenu = {
      entry,
      href: entryHref(entry),
      x: at.x,
      y: at.y,
      // On a phone, as the New menu does, it rises from the bottom.
      sheet: window.innerWidth < 640,
      opener: at.opener,
    };
  }

  function closeEntryMenu(returnFocus: boolean) {
    const opener = entryMenu?.opener;
    entryMenu = null;
    if (returnFocus) opener?.focus();
  }

  /** As in Google Drive, a mouse asking for the menu of a row not chosen chooses just that row. */
  function chooseForMenu(entry: FileEntry) {
    if (lastPointer !== 'mouse' || selection.has(entry.name)) return;
    cursor = entry.name;
    selection.only(entry.name);
  }

  function handleMenuButton(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    if (entryMenu?.entry.name === entry.name) {
      closeEntryMenu(false);
      return;
    }
    chooseForMenu(entry);
    const button = e.currentTarget as HTMLElement;
    const box = button.getBoundingClientRect();
    openEntryMenu(entry, { x: box.right - 224, y: box.bottom + 4, opener: button });
  }

  /** A right click; a long press with a finger, Android's too, chooses the row through `longPress`. */
  function handleRowContextMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    chooseForMenu(entry);
    openEntryMenu(entry, { x: e.clientX, y: e.clientY, opener: e.currentTarget as HTMLElement });
  }

  /*
   * Several items chosen at once, as in Google Drive: Ctrl/⌘+click, Shift+click,
   * a row's checkbox, a rectangle drawn with the mouse, the arrows with Shift,
   * Ctrl/⌘+A and Space, or on a phone a long press, after which taps choose.
   * A bar in place of the list's columns acts on them all.
   */
  const selection = new ListSelection();
  let selectionEntries = $derived(entries.filter((entry) => selection.has(entry.name)));
  let selecting = $derived(selectionEntries.length > 0);

  // Another folder starts at its top with nothing chosen, once it is known which folder is open.
  // Opening a file changes neither.
  $effect(() => {
    if (resolvingPath || loadingEntries) return;
    const folder = folderKey(currentPath);
    untrack(() => {
      if (folder === shownFolder) return;
      shownFolder = folder;
      cursor = null;
      selection.clear();
      fileListRef?.scrollTo(0, 0);
    });
  });

  // As in Google Drive, closing a file leaves the list where it was, on that file. A phone
  // has no use for that: there a chosen row turns taps into choosing.
  let wasOpen: string | null = null;
  $effect(() => {
    const name = openFileName;
    if (isViewingFile && !name) return;
    untrack(() => {
      if (name) {
        cursor = name;
        selection.only(name);
      } else if (wasOpen && finePointer) {
        fileListRef?.focus();
        rowElement(wasOpen)?.scrollIntoView({ block: 'nearest' });
      } else if (wasOpen) {
        cursor = null;
        selection.clear();
      }
      wasOpen = name;
    });
  });

  // What is no longer here is no longer chosen.
  $effect(() => {
    if (loadingEntries) return;
    const here = new Set(entries.map((entry) => entry.name));
    untrack(() => selection.keepOnly(here));
  });

  function clearSelection(focusList = true) {
    selection.clear();
    if (focusList) fileListRef?.focus();
  }

  /** Whether the last press on the list was a finger's: then, while choosing, a tap chooses. */
  let lastPointer = '';

  /**
   * A mouse click chooses just this row and a double click opens it. Ctrl/⌘+click and
   * the leading file icon add or drop a row, and Shift+click chooses the rows from the
   * anchor, none opening a new tab or window. A tap or Enter opens the row at once,
   * except a tap while choosing on a phone.
   */
  function handleRowClick(e: MouseEvent, entry: FileEntry, onCheckbox = false) {
    // The click that ends a long press only lifts the finger.
    if (e.defaultPrevented) return;
    const byMouse = lastPointer === 'mouse' && e.detail > 0;
    const adding = e.shiftKey || e.ctrlKey || e.metaKey || onCheckbox || (selecting && !byMouse);
    if (!adding && !byMouse) return;
    cursor = entry.name;
    // Cancelling a checkbox click rolls back the browser's checked state after this handler.
    if (!onCheckbox) e.preventDefault();
    // The keys then belong to the list, so no focus outline stays behind on the row clicked.
    if (byMouse && !onCheckbox) fileListRef?.focus();
    if (!adding) selection.only(entry.name);
    else if (e.shiftKey) selection.extendTo(entries.map((item) => item.name), entry.name);
    else selection.toggle(entry.name);
    if (onCheckbox && e.currentTarget instanceof HTMLInputElement) e.currentTarget.checked = selection.has(entry.name);
  }

  // A file just uploaded here scrolls into view once the list shows it.
  $effect(() => {
    const name = $revealFile;
    if (!name || !entries.some((entry) => entry.name === name)) return;
    revealFile.set(null);
    queueMicrotask(() => rowElement(name)?.scrollIntoView({ block: 'nearest' }));
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.target instanceof Element && e.target.closest('textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const key = e.key.toLowerCase();
    // Space belongs to the checkbox. File actions also work after selecting by checkbox.
    if (e.target instanceof HTMLInputElement && (e.target.type !== 'checkbox' || key === ' ')) return;

    if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && !e.getModifierState('AltGraph')) {
      // On Mac, Option can change the letter itself (for example, Option+M is µ).
      const action = /^[a-z]$/.test(key) ? key : e.code.replace(/^Key/, '').toLowerCase();
      if (!['a', 'l', 'm'].includes(action)) return;
      const focused = chosenEntry();
      const items = selectionEntries.length ? selectionEntries : focused ? [focused] : [];
      if (!items.length) return;
      e.preventDefault();
      if (action === 'l') void copyEntryLinks(items.map(entry => ({ entry, href: entryHref(entry) })), currentPath);
      if (action === 'm' && canEdit) openMove(items, currentPath, () => fileListRef?.focus());
      if (action === 'a') {
        if (items.length === 1) shareEntry(items[0], entryHref(items[0]), currentPath, canEdit);
        else toast.info('Select one item to share');
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && key === 'a') {
      e.preventDefault();
      selection.selectAll(entries.map((entry) => entry.name));
      return;
    }

    if (key === ' ') {
      // The row the keyboard is on, the one picked with the arrows, or the open file.
      const name = e.target instanceof Element ? e.target.closest('[data-entry-name]')?.getAttribute('data-entry-name') : null;
      const target = (name ? entries.find((entry) => entry.name === name) : null) ?? chosenEntry();
      if (!target) return;
      e.preventDefault();
      selection.toggle(target.name);
      return;
    }

    if (key === 'contextmenu' || (key === 'f10' && e.shiftKey)) {
      const targetEntry = chosenEntry();
      if (!targetEntry) return;
      e.preventDefault();
      const row = rowElement(targetEntry.name);
      const box = row?.getBoundingClientRect();
      openEntryMenu(targetEntry, {
        x: box ? box.left + 48 : 0,
        y: box ? box.bottom : 0,
        opener: fileListRef ?? null,
      });
      return;
    }

    const hashDelete = key === '#' && !e.metaKey && (!e.ctrlKey || e.getModifierState('AltGraph'));
    if ((key === 'delete' || key === 'backspace' || hashDelete) && canEdit) {
      if (selecting) {
        e.preventDefault();
        void deleteChosen(selectionEntries, () => clearSelection());
        return;
      }
      const targetEntry = chosenEntry();
      if (targetEntry) {
        e.preventDefault();
        void deleteEntry(targetEntry.name, currentPath).catch(error => toast.error(error instanceof Error ? error.message : 'Could not delete the item'));
        cursor = null;
      }
      return;
    }

    if (key === 'f2' && canEdit && selectionEntries.length <= 1) {
      const entry = selectionEntries[0] ?? chosenEntry();
      if (!entry) return;
      e.preventDefault();
      openRename(entry.name, entry.type === LinkType.Dir, () => fileListRef?.focus(), currentPath);
      return;
    }

    if (key === 'enter') {
      const entry = chosenEntry();
      if (!entry) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) window.open(entryHref(entry), '_blank', 'noopener');
      else open(entry);
      return;
    }

    const forward = ['arrowdown', 'arrowright', 'j', 'l'].includes(key);
    if (!forward && !['arrowup', 'arrowleft', 'k', 'h'].includes(key)) return;
    // Ctrl/⌘ with a letter belongs to the browser.
    if ((e.ctrlKey || e.metaKey) && !key.startsWith('arrow')) return;
    e.preventDefault();

    const newIndex = grid && ['arrowdown', 'arrowup', 'j', 'k'].includes(key)
      ? verticalGridIndex(fileListRef, cursorIndex, forward)
      : Math.max(0, Math.min(entries.length - 1, cursorIndex + (forward ? 1 : -1)));
    const entry = entries[newIndex];
    if (!entry) return;
    // As in Google Drive: Shift chooses from the anchor to here, Ctrl/⌘ only moves (Space then
    // chooses), and a plain arrow chooses just this row. Nothing opens until Enter.
    if (e.shiftKey) selection.extendTo(entries.map((item) => item.name), entry.name, cursor ?? entry.name);
    else if (!e.ctrlKey && !e.metaKey) selection.only(entry.name);
    cursor = entry.name;
    fileListRef?.focus({ preventScroll: true });
    rowElement(entry.name)?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0 [--folder-actions-width:5.5rem]">
  {#if knownShare && !sharedFolder}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm" role="status">You no longer have access to this folder.</div>
  {:else if !rootCid && currentTreeName && !isOwnTrees && !isProtectedTreeWithoutAccess}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm">
      <span class="i-lucide-loader-2 animate-spin mr-2"></span>
      Loading...
    </div>
  {:else}
    <FolderHeader
      {parentHref}
      ownerNpub={viewedNpub && !viewedNostrIdentityId ? viewedNpub : null}
      crumbs={parentCrumbs}
      name={currentDirName}
      access={currentAccess}
      visibility={currentTreeVisibility}
      {canEdit}
      dirCid={currentDirCid}
      showActions={(!!currentDirCid || canEdit) && !isProtectedTreeWithoutAccess}
    />

    {#if entries.length > 0 && !waitingForFolder && (!resolvingPath || opensFile) && !isProtectedTreeWithoutAccess}
      <!-- As in Google Drive, what acts on the chosen items takes the columns' place; the rest stays put. -->
      <ListSortHeader bind:sort bind:grid {selecting}>
        <SelectionBar
          entries={selectionEntries}
          path={currentPath}
          {canEdit}
          zipName="{currentDirName || 'Drive'}.zip"
          list={fileListRef}
          onClear={() => clearSelection()}
        />
      </ListSortHeader>
    {/if}

    <div
      bind:this={fileListRef}
      data-drive-undo
      data-testid="file-list"
      data-scroll-root
      data-layout={grid ? 'grid' : 'list'}
      class="flex-1 overflow-auto relative outline-none {canEdit ? 'pb-24 sm:pb-4' : 'pb-4'} {isDraggingOver ? 'bg-accent/10' : ''}"
      tabindex="0"
      role="listbox"
      aria-label="File list"
      aria-multiselectable="true"
      onkeydown={handleKeyDown}
      onpointerdowncapture={(e) => { lastPointer = e.pointerType; }}
      onclick={(e) => { if (!selecting && !(e.target as Element).closest('[data-entry-name]')) cursor = null; }}
      oncontextmenu={(e) => { if (entryMenu) e.preventDefault(); else if (canEdit) openNewMenuBeside(e); }}
      ondragover={handleFileDragOver}
      ondragleave={handleFileDragLeave}
      ondrop={handleFileDrop}
    >
      <SelectionRectangle list={fileListRef} {selection} />
      {#if isDraggingOver}
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-10 border-2 border-dashed border-accent rounded m-2">
          <span class="text-accent font-medium">{dropTargetDir && !dragging ? `Drop to add to ${dropTargetDir}` : 'Drop files to add'}</span>
        </div>
      {/if}

      {#if resolvingPath && !opensFile}
        <div class="p-4"></div>
      {:else}
        {#if isProtectedTreeWithoutAccess}
          <ProtectedTreeNotice visibility={effectiveTree?.visibility} {linkKey} />
        {:else if waitingForFolder}
          <div class="p-4 pl-6"></div>
        {:else if entries.length === 0}
          <EmptyFolder {canEdit} draggingOver={isDraggingOver} />
        {:else}
          <FolderEntries grid={grid}>
          {#snippet children(mediaReady)}
          {#each entries as entry, idx (entry.name)}
            {@const documentInfo = entry.type === LinkType.Dir ? documentKindInfo(entry.name) : null}
            {@const isDocument = !!documentInfo}
            {@const title = isDocument ? documentTitle(entry.name) : entry.name}
            {@const isFolder = entry.type === LinkType.Dir && !isDocument}
            {@const icon = documentInfo ? documentInfo.icon : isFolder ? 'i-lucide-folder text-warning' : fileIcon(entry.name)}
            {@const entryAccess = accessAt([...currentPath, entry.name])}
            {@const menuOpen = entryMenu?.entry.name === entry.name}
            {@const checked = selection.has(entry.name)}
            {@const detailsId = modifiedAt(entry) !== null || entry.type !== LinkType.Dir ? `${uid}-details-${idx}` : undefined}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class:folder-tile={grid && isFolder}
              class="group relative flex items-center {grid ? 'rounded-xl' : 'border-b border-surface-2 sm:grid sm:grid-cols-[minmax(0,1fr)_var(--folder-actions-width)]'} {checked ? 'bg-accent/20 hover:bg-accent/25' : menuOpen ? 'bg-surface-2/70' : `hover:bg-surface-2/50 ${grid ? 'bg-surface-1' : ''}`} {cursor === entry.name && !checked ? 'ring-2 ring-inset ring-accent' : ''} {recentlyChanged.has(entry.name) && !checked ? 'animate-pulse-live' : ''} {dragging?.items.has(entry.name) ? 'opacity-50' : ''} {dropTargetDir === entry.name ? 'bg-accent/20 ring-2 ring-inset ring-accent' : ''}"
              data-testid="file-row"
              data-entry-name={entry.name}
              data-changed={recentlyChanged.has(entry.name) ? '' : undefined}
              ondragover={isFolder ? (e) => handleDirDragOver(e, entry.name) : undefined}
              ondragleave={isFolder ? handleDirDragLeave : undefined}
              ondrop={isFolder ? (e) => handleDirDrop(e, entry.name) : undefined}
            >
              <!-- The file icon doubles as a checkbox. Only a chosen item shows a checkmark. -->
              <input
                type="checkbox"
                class="absolute top-1/2 -translate-y-1/2 z-1 m-0 w-8 h-8 appearance-none rounded-full border-0 bg-transparent cursor-pointer hover:bg-accent/10 focus-visible:outline-accent left-1 lg:left-3"
                {checked}
                aria-label="Select {title}"
                title={checked ? `Deselect ${title}` : `Select ${title}`}
                onclick={(e) => handleRowClick(e, entry, true)}
              />
              <a
                href={entryHref(entry)}
                class="min-w-0 flex-1 p-3 lg:pl-5 pr-1 flex items-center gap-3 no-underline text-text-1 select-none [-webkit-touch-callout:none]"
                aria-describedby={detailsId}
                draggable={finePointer && (canEdit || entry.type !== LinkType.Dir)}
                ondragstart={(e) => handleEntryDragStart(e, entry)}
                ondragend={handleEntryDragEnd}
                onclick={(e) => handleRowClick(e, entry)}
                ondblclick={(e) => { if (!(e.shiftKey || e.ctrlKey || e.metaKey)) open(entry); }}
                oncontextmenu={(e) => handleRowContextMenu(e, entry)}
                use:longPress={() => selection.add(entry.name)}
                data-testid={isDocument ? 'document-entry' : undefined}
              >
                <FileEntryLabel documentKind={documentInfo?.kind ?? null} {entry} {title} {icon} {isFolder} {checked} {detailsId} {mediaReady} {grid}
                  access={entryAccess?.kind !== 'private' && entryAccess?.kind !== currentAccess?.kind ? entryAccess : null} />
              </a>
              <button
                type="button"
                class="btn-circle shrink-0 justify-self-end mr-1.5 lg:mr-3 b-0 bg-transparent cursor-pointer text-text-3 hover:text-text-1 hover:bg-surface-3 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 {menuOpen ? 'sm:opacity-100 bg-surface-3' : ''}"
                title="More actions"
                aria-label="More actions for {title}"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                tabindex="-1"
                data-testid="row-menu-btn"
                onclick={(e) => handleMenuButton(e, entry)}
              >
                <span class="i-lucide-ellipsis-vertical text-base"></span>
              </button>
            </div>
          {/each}
          {/snippet}
          </FolderEntries>
        {/if}
      {/if}
    </div>
  {/if}
  {#if entryMenu}
    <EntryMenu request={entryMenu} path={currentPath} {canEdit} onClose={closeEntryMenu} />
  {/if}
  <div class="sr-only" role="status">{selecting ? `${selectionEntries.length} selected` : ''}</div>
</div>
