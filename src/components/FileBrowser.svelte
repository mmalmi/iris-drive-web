<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { toHex, LinkType, type TreeEntry as FileEntry } from '@hashtree/core';
  import { COPY_NAME_PARAM } from '../lib/shareUrls';
  import { untrack } from 'svelte';
  import { addCopiedEntry, deleteEntry } from '../actions';
  import EmptyFolder from './EmptyFolder.svelte';
  import { openNewMenuBeside } from './NewMenu.svelte';
  import { moveAndTell } from './Modals/MoveModal.svelte';
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
  import { nostrStore, npubToPubkey } from '../nostr';
  import { UserRow } from './User';
  import FolderHeader from './FolderHeader.svelte';
  import EntryMenu, { type EntryMenuRequest } from './EntryMenu.svelte';
  import { longPress } from '../lib/longPress';
  import VisibilityIcon from './VisibilityIcon.svelte';
  import { itemAccess } from '../drive/itemAccess';
  import { linkShares } from '../drive/linkShares';
  import ProtectedTreeNotice from './ProtectedTreeNotice.svelte';
  import { treeRootStore, routeStore, createTreesStore, type TreeEntry, currentDirCidStore, isViewingFileStore, resolvingPathStore, directoryEntriesStore, permalinkSnapshotStore } from '../stores';
  import { buildPathHref } from './fileBrowserHrefs';
  import { activeShareScope, shareLocation } from '../drive/shareScope';
  import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
  import { isNostrIdentityId } from '../utils/route';
  import IdentityName from './User/IdentityName.svelte';

  import { fileIcon } from '../lib/fileIcon';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';
  import { BREAKPOINTS } from '@iris/hashtree-app/breakpoints';

  interface Props {
    compact?: boolean;
  }

  let { compact = false }: Props = $props();
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
  let currentPath = $derived(isViewingFile ? urlPath.slice(0, -1) : urlPath);
  let rootHash = $derived(rootCid?.hash ?? null);
  let linkKey = $derived(route.params.get('k'));

  let inTreeView = $derived(!!currentTreeName || !!rootHash);
  let viewedNpub = $derived(currentNpub);
  let viewedNostrIdentityId = $derived(viewedNpub && isNostrIdentityId(viewedNpub) ? viewedNpub : null);
  let viewedIdentityAppKeyPubkey = $derived(npubToPubkey(userNpub || '') || '');
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
  function accessAt(path: string[]) {
    if (route.isPermalink) return null;
    return itemAccess({
      scope: viewedNpub,
      treeName: currentTreeName,
      path,
      profileId: activeNostrIdentityRootScope($nostrStore),
      appKeyPubkey: $nostrStore.pubkey,
      records: $acceptedShares,
      linkShares: $linkShares,
      treeVisibility: effectiveTree?.visibility,
    });
  }
  let currentAccess = $derived(accessAt(currentPath));

  let isProtectedTreeWithoutAccess = $derived(
    !isOwnTrees &&
    missingDecryptionKey &&
    effectiveTree &&
    (effectiveTree.visibility === 'link-visible' || effectiveTree.visibility === 'private')
  );

  $effect(() => {
    const store = treesStore;
    const unsub = store.subscribe(value => {
      trees = value;
    });
    return unsub;
  });

  let dirEntries = $derived($directoryEntriesStore);
  /** How the list is sorted, as last chosen on this device. */
  let sort = $state<ListSort>(loadSort());
  let grid = $state(loadGridView());
  let showGrid = $derived(grid && !compact);
  let entries = $derived(sortEntries(dirEntries.entries, sort));
  let resolvingPath = $derived($resolvingPathStore);
  // Treat the store as still loading until its loadedHashKey matches the
  // current directory CID — otherwise stale `entries: []` from a previous
  // navigation can briefly render as an empty folder.
  let currentDirHashKey = $derived(currentDirCid?.hash ? toHex(currentDirCid.hash) : null);
  let entriesAreStale = $derived(
    currentDirHashKey !== null && dirEntries.loadedHashKey !== currentDirHashKey
  );
  let loadingEntries = $derived(dirEntries.loading || entriesAreStale);

  let isDraggingOver = $state(false);
  let fileListRef: HTMLDivElement | undefined = $state();

  $effect(() => {
    route.path;
    fileListRef?.scrollTo(0, 0);
  });

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
  let dragging = $state<string[] | null>(null);
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
    dragging = selection.has(entry.name) ? selectionEntries.map((item) => item.name) : [entry.name];
    data.effectAllowed = 'copyMove';
    data.setData('text/plain', dragging.join('\n'));
  }

  function handleEntryDragEnd() {
    dragging = null;
    dropTargetDir = null;
  }

  /** Moves what was dragged; what has gone is no longer chosen. */
  async function moveDragged(targetPath: string[]) {
    const names = dragging ?? [];
    dragging = null;
    if (names.length) await moveAndTell(currentPath, names, targetPath);
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
    if (dragging.includes(dirName)) return;
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

    if (!canEdit || dragging.includes(dirName)) return;
    await moveDragged([...currentPath, dirName]);
  }

  async function handleParentDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dropTargetDir = null;

    if (!canEdit || !dragging) return;
    await moveDragged(currentPath.slice(0, -1));
  }

  // At the top of a shared folder, ".." leads out of it: nothing can be moved there.
  function handleParentDragOver(e: DragEvent) {
    if (!canEdit || !dragging || currentPath.length === 0) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    dropTargetDir = '..';
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
  let hasParent = $derived(parentHref !== null);
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

  let selectedFileName = $derived(isViewingFile && lastSegment ? lastSegment : null);

  let selectedEntry = $derived(selectedFileName ? entries.find(e => e.name === selectedFileName) : null);
  let selectedIndex = $derived(selectedEntry ? entries.findIndex(e => e.name === selectedEntry.name) : -1);

  let focusedIndex = $state(-1);

  let isFileBrowserOnly = $state(false);
  $effect(() => {
    const checkLayout = () => {
      isFileBrowserOnly = window.innerWidth < BREAKPOINTS.lg;
    };
    checkLayout();
    window.addEventListener('resize', checkLayout);
    return () => window.removeEventListener('resize', checkLayout);
  });

  // Beside an open file the list is the only way around; on its own it has a header for that.
  let showDirectoryNavigationRows = $derived(compact);
  let parentRowIndex = $derived(showDirectoryNavigationRows && hasParent ? 0 : -1);
  let currentDirectoryRowIndex = $derived(
    showDirectoryNavigationRows ? (hasParent ? 1 : 0) : -1
  );
  let specialItemCount = $derived(
    showDirectoryNavigationRows ? (hasParent ? 2 : 1) : 0
  );
  let navItemCount = $derived(specialItemCount + entries.length);

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
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"]')) return true;
    // The app's dialogs cover the page with a fixed layer.
    return !!document.querySelector('[aria-modal="true"], .fixed.inset-0');
  }

  /** The entry a copy or the menu key is about: the one picked with the keyboard, or the open file. */
  function chosenEntry(): FileEntry | null {
    const entryIndex = focusedIndex - specialItemCount;
    if (focusedIndex >= 0) return entryIndex >= 0 ? entries[entryIndex] ?? null : null;
    return selectedEntry ?? null;
  }

  // Pasting into the folder: files copied in Finder or Explorer, a screenshot
  // or copied picture, or plain text kept as a text file.
  $effect(() => {
    if (!inTreeView || !canEdit) return;
    const onPaste = (event: ClipboardEvent) => {
      // Right after moving to another folder, which folder is open is still being worked out.
      if (belongsElsewhere(event) || resolvingPath || loadingEntries) return;
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
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
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

  function handleMenuButton(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    if (entryMenu?.entry.name === entry.name) {
      closeEntryMenu(false);
      return;
    }
    const button = e.currentTarget as HTMLElement;
    const box = button.getBoundingClientRect();
    openEntryMenu(entry, { x: box.right - 224, y: box.bottom + 4, opener: button });
  }

  /** A right click; a long press with a finger, Android's too, chooses the row through `longPress`. */
  function handleRowContextMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    openEntryMenu(entry, { x: e.clientX, y: e.clientY, opener: e.currentTarget as HTMLElement });
  }

  /*
   * Several items chosen at once, as in Google Drive: Ctrl/⌘+click, Shift+click,
   * a row's checkbox, a rectangle drawn with the mouse, the arrows with Shift,
   * Ctrl/⌘+A and Space, or on a phone a long press, after which taps choose.
   * A bar in place of the header acts on them all.
   */
  const selection = new ListSelection();
  let selectionEntries = $derived(entries.filter((entry) => selection.has(entry.name)));
  let selecting = $derived(selectionEntries.length > 0);

  // Another folder starts with nothing chosen, once it is known which folder is open (until
  // then the path still counts an opened or closed file in): a file opened beside it keeps what is.
  $effect(() => {
    const folder = [viewedNpub, currentTreeName, ...currentPath].join('/');
    if (!resolvingPath) untrack(() => selection.showFolder(folder));
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
   * Ctrl/⌘+click chooses a row and Shift+click the rows from the anchor,
   * neither opening a new tab or window. The leading file icon toggles selection.
   * A plain click on the name opens the row and
   * lets go of the rest, except a tap while choosing on a phone.
   */
  function handleRowClick(e: MouseEvent, entry: FileEntry, onCheckbox = false) {
    // The click that ends a long press only lifts the finger.
    if (e.defaultPrevented) return;
    if (!(e.shiftKey || e.ctrlKey || e.metaKey || onCheckbox || (selecting && lastPointer !== 'mouse'))) return selection.clear();
    // Cancelling a checkbox click rolls back the browser's checked state after this handler.
    if (!onCheckbox) e.preventDefault();
    if (e.shiftKey) selection.extendTo(entries.map((item) => item.name), entry.name);
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
    const key = e.key.toLowerCase();
    // A row's checkbox takes its own keys.
    if (e.target instanceof HTMLInputElement) return;

    if ((e.ctrlKey || e.metaKey) && key === 'a') {
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

    if ((key === 'delete' || key === 'backspace') && canEdit) {
      if (selecting) {
        e.preventDefault();
        void deleteChosen(selectionEntries, () => clearSelection());
        return;
      }
      // The focused row, or the open file when no row is focused; never the open file from "..".
      const targetEntry = chosenEntry();
      if (targetEntry) {
        e.preventDefault();
        void deleteEntry(targetEntry.name);
        focusedIndex = -1;
      }
      return;
    }

    if (key === 'enter' && focusedIndex >= 0) {
      e.preventDefault();
      const entry = entries[focusedIndex - specialItemCount];
      const href = focusedIndex === parentRowIndex ? parentHref
        : focusedIndex === currentDirectoryRowIndex ? hrefAt(currentPath)
          : entry ? entryHref(entry) : null;
      if (href) {
        window.location.hash = href.slice(1);
        focusedIndex = -1;
      }
      return;
    }

    if (key !== 'arrowup' && key !== 'arrowdown' && key !== 'arrowleft' && key !== 'arrowright' && key !== 'j' && key !== 'k' && key !== 'h' && key !== 'l') return;

    // Ctrl/⌘ with a letter belongs to the browser.
    if ((e.ctrlKey || e.metaKey) && !key.startsWith('arrow')) return;

    e.preventDefault();

    let currentIndex = focusedIndex;
    if (currentIndex < 0 && selectedIndex >= 0) {
      currentIndex = selectedIndex + specialItemCount;
    }

    let newIndex: number;

    if (showGrid && ['arrowdown', 'arrowup', 'j', 'k'].includes(key)) {
      newIndex = verticalGridIndex(fileListRef, currentIndex, key === 'arrowdown' || key === 'j');
    } else if (key === 'arrowdown' || key === 'arrowright' || key === 'j' || key === 'l') {
      newIndex = currentIndex < navItemCount - 1 ? currentIndex + 1 : 0;
    } else {
      newIndex = currentIndex > 0 ? currentIndex - 1 : navItemCount - 1;
    }

    // As in Google Drive: Shift chooses from the anchor to here, Ctrl/⌘ only moves (Space then
    // chooses), and a plain arrow chooses just this row.
    const newEntry: FileEntry | undefined = entries[newIndex - specialItemCount];
    if (e.shiftKey && newEntry) selection.extendTo(entries.map((entry) => entry.name), newEntry.name, entries[currentIndex - specialItemCount]?.name);
    else if (!e.ctrlKey && !e.metaKey) selection.only(newEntry?.name);
    // Beside the list there is room to show a file the keyboard moves onto, unless it is choosing.
    if (newEntry && newEntry.type !== LinkType.Dir && !isFileBrowserOnly && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      focusedIndex = -1;
      window.location.hash = entryHref(newEntry).slice(1);
    } else {
      focusedIndex = newIndex;
    }
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
    {#if selecting}
      <!-- In place of the header while items are chosen. -->
      <SelectionBar
        entries={selectionEntries}
        path={currentPath}
        {canEdit}
        {compact}
        zipName="{currentDirName || 'Drive'}.zip"
        list={fileListRef}
        onClear={() => clearSelection()}
      />
    {/if}
    {#if compact}
      {#if viewedNpub && !isMyDrive && !selecting}
        <div class="hidden lg:flex h-10 shrink-0 px-3 border-b border-surface-2 items-center gap-2 bg-surface-0">
          {#if viewedNostrIdentityId}
            <div class="min-w-0 flex items-center gap-2 text-sm text-text-2" data-testid="drive-profile-root-scope">
              <span class="i-lucide-folder-root shrink-0 text-text-3"></span>
              {#if sharedFolder}<span class="truncate">{sharedFolder.display_name}</span>{:else}<IdentityName profileId={viewedNostrIdentityId} appKeyPubkey={viewedIdentityAppKeyPubkey} />{/if}
            </div>
          {:else}
            <a href="#/{viewedNpub}/profile" class="no-underline min-w-0">
              <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} class="min-w-0" />
            </a>
          {/if}
        </div>
      {/if}
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
        hidden={selecting}
      />
    {/if}

    {#if !compact && entries.length > 0 && !isProtectedTreeWithoutAccess}
      <ListSortHeader bind:sort bind:grid />
    {/if}

    <div
      bind:this={fileListRef}
      data-testid="file-list"
      data-scroll-root
      data-layout={showGrid ? 'grid' : 'list'}
      class="flex-1 overflow-auto relative outline-none {canEdit && !compact ? 'pb-24 sm:pb-4' : 'pb-4'} {isDraggingOver ? 'bg-accent/10' : ''}"
      tabindex="0"
      role="listbox"
      aria-label="File list"
      aria-multiselectable="true"
      onkeydown={handleKeyDown}
      onpointerdowncapture={(e) => { lastPointer = e.pointerType; }}
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

      {#if resolvingPath}
        <div class="p-4"></div>
      {:else}
        {#if showDirectoryNavigationRows && parentHref}
          <a
            href={parentHref}
            class="p-3 border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {focusedIndex === 0 ? 'ring-2 ring-inset ring-accent' : ''} {dropTargetDir === '..' ? 'bg-accent/20' : ''}"
            ondragover={(e) => handleParentDragOver(e)}
            ondragleave={handleDirDragLeave}
            ondrop={(e) => handleParentDrop(e)}
          >
            <span class="i-lucide-folder text-warning shrink-0"></span>
            <span class="truncate">..</span>
          </a>
        {/if}

        {#if showDirectoryNavigationRows}
          <a
            href={hrefAt(currentPath)}
            class="p-3 border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {!selectedEntry && focusedIndex < 0 ? 'bg-surface-2' : ''} {focusedIndex === currentDirectoryRowIndex ? 'ring-2 ring-inset ring-accent' : ''}"
          >
            <span class="shrink-0 i-lucide-folder-open text-warning"></span>
            <span class="truncate flex-1">{currentDirName}</span>
            {#if currentPath.length === 0}
              {#if route.isPermalink}
                {#if rootCid?.key}
                  <span class="relative inline-block shrink-0 text-text-2" title="Encrypted (has key)">
                    <span class="i-lucide-link"></span>
                    <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
                  </span>
                {:else}
                  <span class="i-lucide-globe text-text-2" title="Public"></span>
                {/if}
              {:else}
                <VisibilityIcon visibility={currentTreeVisibility} class="text-text-2" />
              {/if}
            {/if}
          </a>
        {/if}

        {#if isProtectedTreeWithoutAccess}
          <ProtectedTreeNotice visibility={effectiveTree?.visibility} {linkKey} />
        {:else if loadingEntries}
          <div class="p-4 pl-6"></div>
        {:else if entries.length === 0}
          <EmptyFolder {canEdit} draggingOver={isDraggingOver} />
        {:else}
          <FolderEntries grid={showGrid}>
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
              class:folder-tile={showGrid && isFolder}
              class="group relative flex items-center {showGrid || compact ? '' : 'sm:grid sm:grid-cols-[minmax(0,1fr)_var(--folder-actions-width)]'} {showGrid ? 'rounded-xl bg-surface-1' : 'border-b border-surface-2'} hover:bg-surface-2/50 {selectedEntry?.name === entry.name && focusedIndex < 0 ? 'bg-surface-2' : ''} {checked ? 'bg-accent/20 hover:bg-accent/25' : ''} {menuOpen ? 'bg-surface-2/70' : ''} {focusedIndex === idx + specialItemCount ? 'ring-2 ring-inset ring-accent' : ''} {recentlyChanged.has(entry.name) && selectedEntry?.name !== entry.name ? 'animate-pulse-live' : ''} {dragging?.includes(entry.name) ? 'opacity-50' : ''} {dropTargetDir === entry.name ? 'bg-accent/20 ring-2 ring-inset ring-accent' : ''}"
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
                class="absolute top-1/2 -translate-y-1/2 z-1 m-0 w-8 h-8 appearance-none rounded-full border-0 bg-transparent cursor-pointer hover:bg-accent/10 focus-visible:outline-accent {showDirectoryNavigationRows ? 'left-7' : 'left-1 lg:left-3'}"
                {checked}
                aria-label="Select {title}"
                title={checked ? `Deselect ${title}` : `Select ${title}`}
                onclick={(e) => handleRowClick(e, entry, true)}
              />
              <a
                href={entryHref(entry)}
                class="min-w-0 flex-1 p-3 {showDirectoryNavigationRows ? 'pl-9' : 'lg:pl-5'} pr-1 flex items-center gap-3 no-underline text-text-1 select-none [-webkit-touch-callout:none]"
                aria-describedby={detailsId}
                draggable={finePointer && (canEdit || entry.type !== LinkType.Dir)}
                ondragstart={(e) => handleEntryDragStart(e, entry)}
                ondragend={handleEntryDragEnd}
                onclick={(e) => handleRowClick(e, entry)}
                oncontextmenu={(e) => handleRowContextMenu(e, entry)}
                use:longPress={() => selection.add(entry.name)}
                data-testid={isDocument ? 'document-entry' : undefined}
              >
                <FileEntryLabel {entry} {title} {icon} {isFolder} {checked} {detailsId} {compact} {mediaReady} grid={showGrid}
                  access={entryAccess?.kind !== 'private' && entryAccess?.kind !== currentAccess?.kind ? entryAccess : null} />
              </a>
              <button
                type="button"
                class="btn-circle shrink-0 justify-self-end mr-1.5 {showDirectoryNavigationRows ? '' : 'lg:mr-3'} b-0 bg-transparent cursor-pointer text-text-3 hover:text-text-1 hover:bg-surface-3 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 {menuOpen ? 'sm:opacity-100 bg-surface-3' : ''}"
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
