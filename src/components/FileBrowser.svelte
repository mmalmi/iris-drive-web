<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { toHex, nhashEncode, LinkType, type TreeEntry as FileEntry } from '@hashtree/core';
  import { formatBytes } from '../store';
  import { deleteEntry, moveEntry, moveToParent } from '../actions';
  import { uploadFiles } from '../stores/upload';
  import { recentlyChangedFiles } from '../stores/recentlyChanged';
  import { toast } from '../stores/toast';
  import { getNhashFileUrl } from '../lib/mediaUrl';
  import { copiedMessage, copyEntry, copyKind, downloadDragData, entryLink, isOutsideDrag, pastedIntoFolder } from '../lib/driveClipboard';
  import { addDropped } from '../lib/folderDrop';
  import { nostrStore, npubToPubkey } from '../nostr';
  import { UserRow, Avatar } from './User';
  import FolderActions from './FolderActions.svelte';
  import NewMenu from './NewMenu.svelte';
  import VisibilityIcon from './VisibilityIcon.svelte';
  import AccessBadge from './AccessBadge.svelte';
  import { itemAccess } from '../drive/itemAccess';
  import ProtectedTreeNotice from './ProtectedTreeNotice.svelte';
  import { treeRootStore, routeStore, createTreesStore, type TreeEntry, currentDirCidStore, isViewingFileStore, resolvingPathStore, directoryEntriesStore, permalinkSnapshotStore } from '../stores';
  import {
    buildDirHref as buildFileDirHref,
    buildEntryHref as buildFileEntryHref,
  } from './fileBrowserHrefs';
  import { activeShareScope } from '../drive/shareScope';
  import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
  import { isNostrIdentityId } from '../utils/route';
  import IdentityName from './User/IdentityName.svelte';

  import { getFileIcon } from '@iris/hashtree-app/fileIcon';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';
  import { BREAKPOINTS } from '@iris/hashtree-app/breakpoints';

  interface Props {
    compact?: boolean;
  }

  let { compact = false }: Props = $props();

  function currentSnapshotForHref() {
    return isSnapshotPermalink ? permalinkSnapshot.snapshot : null;
  }

  function buildEntryHref(
    entry: { name: string; type: LinkType },
    currentNpub: string | null,
    currentTreeName: string | null,
    currentPath: string[],
    rootCidForHref: { hash: Uint8Array; key?: Uint8Array } | null,
    linkKey: string | null,
    gitRootPath: string | null
  ): string {
    return buildFileEntryHref({
      entry,
      currentNpub,
      currentTreeName,
      currentPath,
      rootCid: rootCidForHref,
      linkKey,
      gitRootPath,
      snapshot: currentSnapshotForHref(),
    });
  }

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
  let sharedFolder = $derived(activeShareScope(viewedNpub, $nostrStore, $acceptedShares)?.record.folder);
  let isOwnDriveProfile = $derived(isEditableDriveRouteScope(viewedNpub, $nostrStore, $acceptedShares));
  let isOwnTrees = $derived(!viewedNpub || viewedNpub === userNpub || isOwnDriveProfile);
  // The person's own Drive is called My Drive everywhere; "main" is only its address.
  let isMyDrive = $derived(
    !!viewedNpub && currentTreeName === 'main' && !route.isPermalink
      && viewedNpub === activeNostrIdentityRootScope($nostrStore),
  );
  let rootName = $derived(isMyDrive ? 'My Drive' : sharedFolder?.display_name || currentTreeName);
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
  let entries = $derived(dirEntries.entries);
  let resolvingPath = $derived($resolvingPathStore);
  // Treat the store as still loading until its loadedHashKey matches the
  // current directory CID — otherwise stale `entries: []` from a previous
  // navigation can briefly render as "Empty directory".
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
    if (!canEdit || draggingEntry) return;

    if (!e.dataTransfer) return;
    await addDropped(e.dataTransfer, { currentPath, taken: new Set(entries.map(entry => entry.name)), dirName });
  }

  function handleFileDragOver(e: DragEvent) {
    if (!canEdit || draggingEntry) return;
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

  let draggingEntry = $state<string | null>(null);
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
    draggingEntry = entry.name;
    data.effectAllowed = 'copyMove';
    data.setData('text/plain', entry.name);
  }

  function handleEntryDragEnd() {
    draggingEntry = null;
    dropTargetDir = null;
  }

  function handleDirDragOver(e: DragEvent, dirName: string) {
    if (!canEdit) return;
    if (!draggingEntry) {
      // From the desktop or another page: into this folder.
      if (!isOutsideDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      isDraggingOver = true;
      dropTargetDir = dirName;
      return;
    }
    if (draggingEntry === dirName) return;
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
    if (!draggingEntry) {
      await handleFileDrop(e, dirName);
      return;
    }

    if (!canEdit || draggingEntry === dirName) return;

    await moveEntry(draggingEntry, dirName);
    draggingEntry = null;
  }

  async function handleParentDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dropTargetDir = null;

    if (!canEdit || !draggingEntry) return;

    await moveToParent(draggingEntry);
    draggingEntry = null;
  }

  function handleParentDragOver(e: DragEvent) {
    if (!canEdit || !draggingEntry) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    dropTargetDir = '..';
  }

  function buildDirHref(path: string[]): string {
    return buildFileDirHref({
      path,
      currentNpub,
      currentTreeName,
      rootCid,
      linkKey,
      snapshot: currentSnapshotForHref(),
    });
  }

  function buildRootHref(): string {
    if (viewedNpub) return `#/${viewedNpub}`;
    return '#/';
  }

  /** Where "up" leads: the folder above, the list a shared folder came from, or nowhere from My Drive. */
  let parentHref = $derived.by((): string | null => {
    if (currentPath.length > 0) return buildDirHref(currentPath.slice(0, -1));
    if (isMyDrive) return null;
    if (sharedFolder) return '#/shared-with-me';
    return currentNpub ? buildRootHref() : null;
  });
  let hasParent = $derived(parentHref !== null);
  /** The folders above the open one, outermost first. */
  let parentCrumbs = $derived.by(() => {
    const crumbs: { name: string; href: string }[] = [];
    if (sharedFolder) crumbs.push({ name: 'Shared with me', href: '#/shared-with-me' });
    if (currentPath.length === 0 || !rootName) return crumbs;
    crumbs.push({ name: rootName, href: buildDirHref([]) });
    for (let depth = 1; depth < currentPath.length; depth += 1) {
      crumbs.push({ name: currentPath[depth - 1], href: buildDirHref(currentPath.slice(0, depth)) });
    }
    return crumbs;
  });
  let currentDirName = $derived(
    currentPath.length > 0
      ? currentPath[currentPath.length - 1]
      : rootName || (rootCid?.hash ? nhashEncode({ hash: toHex(rootCid.hash), decryptKey: rootCid.key ? toHex(rootCid.key) : undefined }).slice(0, 16) + '...' : '')
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

  /** The entry a copy is about: the one picked with the keyboard, or the open file. */
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
      if (belongsElsewhere(event)) return;
      const pasted = pastedIntoFolder(event.clipboardData, new Set(entries.map(entry => entry.name)));
      if (!pasted) return;
      event.preventDefault();
      const many = pasted.files.length > 1;
      void uploadFiles(pasted.files).then(() => {
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
        event.clipboardData.setData('text/plain', entryLink(entry));
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

  function handleKeyDown(e: KeyboardEvent) {
    const key = e.key.toLowerCase();

    if ((key === 'delete' || key === 'backspace') && canEdit) {
      const entryIndex = focusedIndex - specialItemCount;
      const targetEntry = entryIndex >= 0 ? entries[entryIndex] : selectedEntry;
      if (targetEntry) {
        e.preventDefault();
        if (confirm(`Delete ${targetEntry.name}?`)) {
          deleteEntry(targetEntry.name);
          focusedIndex = -1;
        }
      }
      return;
    }

    if (key === 'enter' && focusedIndex >= 0) {
      e.preventDefault();
      if (focusedIndex === parentRowIndex) {
        window.location.hash = currentPath.length > 0 ? buildDirHref(currentPath.slice(0, -1)).slice(1) : buildRootHref().slice(1);
        focusedIndex = -1;
      } else if (focusedIndex === currentDirectoryRowIndex) {
        window.location.hash = buildDirHref(currentPath).slice(1);
        focusedIndex = -1;
      } else {
        const entryIndex = focusedIndex - specialItemCount;
        const entry = entries[entryIndex];
        if (entry) {
          const href = buildEntryHref(entry, currentNpub, currentTreeName, currentPath, rootCid, linkKey, null);
          window.location.hash = href.slice(1);
          focusedIndex = -1;
        }
      }
      return;
    }

    if (key !== 'arrowup' && key !== 'arrowdown' && key !== 'arrowleft' && key !== 'arrowright' && key !== 'j' && key !== 'k' && key !== 'h' && key !== 'l') return;

    if (e.ctrlKey || e.metaKey) return;

    e.preventDefault();

    let currentIndex = focusedIndex;
    if (currentIndex < 0 && selectedIndex >= 0) {
      currentIndex = selectedIndex + specialItemCount;
    }

    let newIndex: number;

    if (key === 'arrowdown' || key === 'arrowright' || key === 'j' || key === 'l') {
      newIndex = currentIndex < navItemCount - 1 ? currentIndex + 1 : 0;
    } else {
      newIndex = currentIndex > 0 ? currentIndex - 1 : navItemCount - 1;
    }

    if (newIndex === parentRowIndex) {
      focusedIndex = newIndex;
    } else if (newIndex === currentDirectoryRowIndex) {
      focusedIndex = newIndex;
    } else {
      const entryIndex = newIndex - specialItemCount;
      const newEntry = entries[entryIndex];
      if (newEntry) {
        if (newEntry.type === LinkType.Dir || isFileBrowserOnly) {
          focusedIndex = newIndex;
        } else {
          focusedIndex = -1;
          const href = buildEntryHref(newEntry, currentNpub, currentTreeName, currentPath, rootCid, linkKey, null);
          window.location.hash = href.slice(1);
        }
      }
    }
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0">
  {#if knownShare && !sharedFolder}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm" role="status">You no longer have access to this folder.</div>
  {:else if !rootCid && currentTreeName && !isOwnTrees && !isProtectedTreeWithoutAccess}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm">
      <span class="i-lucide-loader-2 animate-spin mr-2"></span>
      Loading...
    </div>
  {:else}
    {#if compact}
      {#if viewedNpub && !isMyDrive}
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
      <!-- Where you are, with sharing beside it. New is in the sidebar, or here where there is none. -->
      <div
        class="shrink-0 flex items-center gap-2 sm:gap-3 px-3 py-2 lg:px-5 lg:py-3 border-b border-surface-2 bg-surface-0"
        data-testid="folder-header"
      >
        <div class="min-w-0 flex-1 flex items-center gap-1.5 min-h-9">
          {#if parentHref}
            <a
              href={parentHref}
              class="lg:hidden btn-circle btn-ghost shrink-0 no-underline"
              title="Back"
              aria-label="Back"
            >
              <span class="i-lucide-chevron-left text-lg"></span>
            </a>
          {/if}
          {#if viewedNpub && !viewedNostrIdentityId}
            <a href="#/{viewedNpub}/profile" class="lg:hidden shrink-0">
              <Avatar pubkey={npubToPubkey(viewedNpub) || ''} size={20} />
            </a>
          {/if}
          <span class="i-lucide-folder-open text-lg lg:text-xl text-warning shrink-0 mr-0.5"></span>
          <nav class="hidden lg:contents" aria-label="Folder path">
            {#if viewedNpub && !viewedNostrIdentityId}
              <a href="#/{viewedNpub}/profile" class="min-w-8 shrink-100 no-underline">
                <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} class="min-w-0" />
              </a>
              <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
            {/if}
            {#each parentCrumbs as crumb (crumb.href)}
              <a href={crumb.href} class="min-w-8 shrink-100 truncate text-xl text-text-3 no-underline hover:text-text-1">{crumb.name}</a>
              <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
            {/each}
          </nav>
          <h1 class="min-w-0 truncate text-base lg:text-xl font-medium text-text-1">{currentDirName}</h1>
          {#if currentAccess}
            <AccessBadge access={currentAccess} label class="ml-1" />
          {:else}
            <VisibilityIcon visibility={currentTreeVisibility} class="text-text-3 shrink-0 ml-1" />
          {/if}
        </div>
        {#if canEdit}
          <NewMenu variant="folder" class="shrink-0" />
        {/if}
        {#if currentDirCid || canEdit}
          <FolderActions
            dirCid={currentDirCid}
            dirName={currentDirName}
            {canEdit}
          />
        {/if}
      </div>
    {/if}

    <div
      bind:this={fileListRef}
      data-testid="file-list"
      class="flex-1 overflow-auto relative outline-none {canEdit && !compact ? 'pb-24 sm:pb-4' : 'pb-4'} {isDraggingOver ? 'bg-accent/10' : ''}"
      tabindex="0"
      role="listbox"
      aria-label="File list"
      onkeydown={handleKeyDown}
      ondragover={handleFileDragOver}
      ondragleave={handleFileDragLeave}
      ondrop={handleFileDrop}
    >
      {#if isDraggingOver}
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none z-10 border-2 border-dashed border-accent rounded m-2">
          <span class="text-accent font-medium">{dropTargetDir && !draggingEntry ? `Drop to add to ${dropTargetDir}` : 'Drop files to add'}</span>
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
            href={buildDirHref(currentPath)}
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
          <div class="p-4 pl-6 text-center text-muted text-sm">
            {isDraggingOver ? '' : 'Empty directory'}
          </div>
        {:else}
          {#each entries as entry, idx (entry.name)}
            {@const documentInfo = entry.type === LinkType.Dir ? documentKindInfo(entry.name) : null}
            {@const isDocument = !!documentInfo}
            {@const isFolder = entry.type === LinkType.Dir && !isDocument}
            {@const entryAccess = accessAt([...currentPath, entry.name])}
            <a
              href={buildEntryHref(entry, currentNpub, currentTreeName, currentPath, rootCid, linkKey, null)}
              class="p-3 {showDirectoryNavigationRows ? 'pl-9' : 'lg:px-5'} border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {selectedEntry?.name === entry.name && focusedIndex < 0 ? 'bg-surface-2' : ''} {focusedIndex === idx + specialItemCount ? 'ring-2 ring-inset ring-accent' : ''} {recentlyChanged.has(entry.name) && selectedEntry?.name !== entry.name ? 'animate-pulse-live' : ''} {draggingEntry === entry.name ? 'opacity-50' : ''} {dropTargetDir === entry.name ? 'bg-accent/20 ring-2 ring-inset ring-accent' : ''}"
              draggable={canEdit || entry.type !== LinkType.Dir}
              ondragstart={(e) => handleEntryDragStart(e, entry)}
              ondragend={handleEntryDragEnd}
              ondragover={isFolder ? (e) => handleDirDragOver(e, entry.name) : undefined}
              ondragleave={isFolder ? handleDirDragLeave : undefined}
              ondrop={isFolder ? (e) => handleDirDrop(e, entry.name) : undefined}
              data-testid={isDocument ? 'document-entry' : undefined}
            >
              <span class="shrink-0 {documentInfo ? documentInfo.icon : isFolder ? 'i-lucide-folder text-warning' : `${getFileIcon(entry.name)} text-text-2`}"></span>
              <span class="truncate min-w-0" title={entry.name}>{isDocument ? documentTitle(entry.name) : entry.name}</span>
              <!-- Marked where sharing starts; inside a shared folder the heading says it once. -->
              {#if entryAccess && entryAccess.kind !== 'private' && entryAccess.kind !== currentAccess?.kind}
                <AccessBadge access={entryAccess} class="text-text-3 text-sm" />
              {/if}
              <span class="flex-1"></span>
              <span class="shrink-0 text-muted text-sm min-w-12 text-right">
                {entry.type !== LinkType.Dir && entry.size !== undefined ? formatBytes(entry.size) : ''}
              </span>
            </a>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}
</div>
