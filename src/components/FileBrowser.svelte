<script lang="ts">
  import { acceptedShares } from '../drive/shareLibrary';
  import { toHex, nhashEncode, LinkType } from '@hashtree/core';
  import { formatBytes } from '../store';
  import { deleteEntry, moveEntry, moveToParent } from '../actions';
  import { uploadFiles, uploadDirectory } from '../stores/upload';
  import { recentlyChangedFiles } from '../stores/recentlyChanged';
  import { nostrStore, npubToPubkey } from '../nostr';
  import { UserRow, Avatar } from './User';
  import FolderActions from './FolderActions.svelte';
  import VisibilityIcon from './VisibilityIcon.svelte';
  import FileBrowserTreeList from './FileBrowserTreeList.svelte';
  import ProtectedTreeNotice from './ProtectedTreeNotice.svelte';
  import { treeRootStore, routeStore, createTreesStore, type TreeEntry, currentDirCidStore, isViewingFileStore, resolvingPathStore, directoryEntriesStore, permalinkSnapshotStore } from '../stores';
  import { readFilesFromDataTransfer, hasDirectoryItems } from '@iris/hashtree-app/directory';
  import {
    buildDirHref as buildFileDirHref,
    buildEntryHref as buildFileEntryHref,
    buildTreeHref,
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

  let shareUrl = $derived.by(() => {
    const base = window.location.origin + window.location.pathname + '#';
    const npub = viewedNpub || userNpub;
    let url = base;
    if (npub) {
      url += `/${npub}`;
      if (currentTreeName) {
        url += `/${currentTreeName}`;
        if (urlPath.length > 0) {
          url += '/' + urlPath.join('/');
        }
      }
    } else {
      url += '/';
    }
    if (linkKey) {
      url += `?k=${linkKey}`;
    }
    return url;
  });

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

  let sortedTrees = $derived(
    isOwnTrees
      ? [...trees].sort((a, b) => {
          const defaultFolderOrder = ['public', 'link', 'private'];
          const aIdx = defaultFolderOrder.indexOf(a.name);
          const bIdx = defaultFolderOrder.indexOf(b.name);
          if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
          if (aIdx >= 0) return -1;
          if (bIdx >= 0) return 1;
          return a.name.localeCompare(b.name);
        })
      : trees
  );

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

  async function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingOver = false;
    if (!canEdit) return;

    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    if (hasDirectoryItems(dataTransfer) || dataTransfer.items?.length > 0) {
      const result = await readFilesFromDataTransfer(dataTransfer);
      if (result.files.length > 0) {
        await uploadDirectory(result);
        return;
      }
    }

    const files = dataTransfer.files;
    if (files && files.length > 0) {
      await uploadFiles(files);
    }
  }

  function handleFileDragOver(e: DragEvent) {
    if (!canEdit) return;
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
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

  function handleEntryDragStart(e: DragEvent, entryName: string) {
    if (!canEdit) {
      e.preventDefault();
      return;
    }
    draggingEntry = entryName;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', entryName);
  }

  function handleEntryDragEnd() {
    draggingEntry = null;
    dropTargetDir = null;
  }

  function handleDirDragOver(e: DragEvent, dirName: string) {
    if (!canEdit || !draggingEntry || draggingEntry === dirName) return;
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

    if (!canEdit || !draggingEntry || draggingEntry === dirName) return;

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
  let treeFocusedIndex = $state(-1);

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
      fileListRef?.focus();
    }, 50);
    return () => clearTimeout(timer);
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

  function handleTreeListKeyDown(e: KeyboardEvent) {
    if (sortedTrees.length === 0) return;

    const key = e.key.toLowerCase();

    if (key === 'enter' && treeFocusedIndex >= 0) {
      e.preventDefault();
      const tree = sortedTrees[treeFocusedIndex];
      if (tree) {
        window.location.hash = buildTreeHref(targetNpub!, tree.name, tree.linkKey).slice(1);
        treeFocusedIndex = -1;
      }
      return;
    }

    if (key !== 'arrowup' && key !== 'arrowdown' && key !== 'j' && key !== 'k') return;

    e.preventDefault();

    const selectedTreeIndex = currentTreeName ? sortedTrees.findIndex(t => t.name === currentTreeName) : -1;
    const currentIndex = treeFocusedIndex >= 0 ? treeFocusedIndex : selectedTreeIndex;
    let newIndex: number;

    if (key === 'arrowdown' || key === 'j') {
      newIndex = currentIndex < sortedTrees.length - 1 ? currentIndex + 1 : 0;
    } else {
      newIndex = currentIndex > 0 ? currentIndex - 1 : sortedTrees.length - 1;
    }

    treeFocusedIndex = newIndex;
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0">
  {#if !inTreeView}
    <FileBrowserTreeList
      bind:fileListRef
      {viewedNpub}
      {userNpub}
      {isLoggedIn}
      {isOwnTrees}
      {shareUrl}
      {sortedTrees}
      {targetNpub}
      {currentTreeName}
      {treeFocusedIndex}
      {viewedIdentityAppKeyPubkey}
      onKeyDown={handleTreeListKeyDown}
    />
  {:else if knownShare && !sharedFolder}
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
              <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} showBadge class="min-w-0" />
            </a>
          {/if}
        </div>
      {/if}
    {:else}
      <!-- Where you are, with sharing beside it and the adding buttons beneath. -->
      <div
        class="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 lg:px-5 lg:py-3 border-b border-surface-2 bg-surface-0"
        data-testid="folder-header"
      >
        <div class="order-1 min-w-0 flex-1 flex items-center gap-1.5 min-h-9">
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
                <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} showBadge class="min-w-0" />
              </a>
              <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
            {/if}
            {#each parentCrumbs as crumb (crumb.href)}
              <a href={crumb.href} class="min-w-8 shrink-100 truncate text-xl text-text-3 no-underline hover:text-text-1">{crumb.name}</a>
              <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
            {/each}
          </nav>
          <h1 class="min-w-0 truncate text-base lg:text-xl font-medium text-text-1">{currentDirName}</h1>
          <VisibilityIcon visibility={currentTreeVisibility} class="text-text-3 shrink-0 ml-1" />
        </div>
        {#if currentDirCid || canEdit}
          <FolderActions
            dirCid={currentDirCid}
            dirName={currentDirName}
            {canEdit}
            menuClass="order-2"
            toolbarClass="order-3 basis-full"
          />
        {/if}
      </div>
    {/if}

    <div
      bind:this={fileListRef}
      data-testid="file-list"
      class="flex-1 overflow-auto relative outline-none pb-4 {isDraggingOver ? 'bg-accent/10' : ''}"
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
          <span class="text-accent font-medium">Drop files to add</span>
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
            <a
              href={buildEntryHref(entry, currentNpub, currentTreeName, currentPath, rootCid, linkKey, null)}
              class="p-3 {showDirectoryNavigationRows ? 'pl-9' : 'lg:px-5'} border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {selectedEntry?.name === entry.name && focusedIndex < 0 ? 'bg-surface-2' : ''} {focusedIndex === idx + specialItemCount ? 'ring-2 ring-inset ring-accent' : ''} {recentlyChanged.has(entry.name) && selectedEntry?.name !== entry.name ? 'animate-pulse-live' : ''} {draggingEntry === entry.name ? 'opacity-50' : ''} {dropTargetDir === entry.name ? 'bg-accent/20' : ''}"
              draggable={canEdit}
              ondragstart={(e) => handleEntryDragStart(e, entry.name)}
              ondragend={handleEntryDragEnd}
              ondragover={isFolder ? (e) => handleDirDragOver(e, entry.name) : undefined}
              ondragleave={isFolder ? handleDirDragLeave : undefined}
              ondrop={isFolder ? (e) => handleDirDrop(e, entry.name) : undefined}
              data-testid={isDocument ? 'document-entry' : undefined}
            >
              <span class="shrink-0 {documentInfo ? documentInfo.icon : isFolder ? 'i-lucide-folder text-warning' : `${getFileIcon(entry.name)} text-text-2`}"></span>
              <span class="truncate flex-1 min-w-0" title={entry.name}>{isDocument ? documentTitle(entry.name) : entry.name}</span>
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
