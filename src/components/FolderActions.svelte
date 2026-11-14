<script lang="ts">
  /**
   * Folder actions, used in FileBrowser and Viewer: the share button and a
   * menu of the less common actions. Making and adding things is in NewMenu.
   */
  import type { CID } from '@hashtree/core';
  import Menu, { type MenuItem } from './ui/Menu.svelte';
  import { COPY_NAME_PARAM, createDriveShareLinkVariants, folderCopyHref } from '../lib/shareUrls';
  import { open as openRenameModal } from './Modals/RenameModal.svelte';
  import { open as openMoveModal } from './Modals/MoveModal.svelte';
  import { open as openForkModal } from './Modals/ForkModal.svelte';
  import ShareButton from './ShareButton.svelte';
  import { open as openBlossomPushModal } from './Modals/BlossomPushModal.svelte';
  import { deleteCurrentFolder, buildRouteUrl, getCurrentRootCid, makeCopyOfFolder } from '../actions';
  import { toast } from '../stores/toast';
  import { nostrStore, deleteTree, npubToPubkey } from '../nostr';
  import { downloadFolderZip } from '../lib/downloadEntry';
  import { routeStore, createTreesStore, permalinkSnapshotStore, isViewingFileStore } from '../stores';
  import {
    buildTreeEventPermalink,
    ensureTreeEventSnapshotForRoot,
    watchLatestTreeEventSnapshot,
    getCachedTreeEventSnapshot,
    isNewerTreeEventSnapshot,
    snapshotMatchesRootCid,
  } from '../lib/treeEventSnapshots';
  import { acceptedShares } from '../drive/shareLibrary';
  import { sharePeopleTarget } from '../drive/sharePeople';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { isNostrIdentityId } from '../utils/route';

  interface Props {
    dirCid?: CID | null;
    dirName?: string | null;
    canEdit: boolean;
    /** Placement of the share button and the menu within the parent. */
    menuClass?: string;
  }

  let { dirCid = null, dirName = null, canEdit, menuClass = '' }: Props = $props();

  let isDownloading = $state(false);
  let zipAbortController = $state<AbortController | null>(null);

  let route = $derived($routeStore);
  let permalinkSnapshot = $derived($permalinkSnapshotStore);
  let userNpub = $derived($nostrStore.npub);

  // The user's own trees, for fork name suggestions: Fork is offered outside
  // Drive and saves under the npub.
  let ownTreesStore = $derived(createTreesStore(userNpub));
  let ownTrees = $state<Array<{ name: string }>>([]);

  $effect(() => {
    const store = ownTreesStore;
    const unsub = store.subscribe(value => {
      ownTrees = value;
    });
    return unsub;
  });

  let ownTreeNames = $derived(ownTrees.map(t => t.name));
  /** The folder's own name, carried by a read-only copy's link so it opens under that name. */
  let copyName = $derived(
    route.path.length > 0
      ? route.path[route.path.length - 1]!
      : route.isPermalink
        ? route.params.get(COPY_NAME_PARAM)
        : dirName !== 'My Drive' ? dirName : null,
  );
  let permalinkHref = $state<string | null>(null);
  let latestVersionHref = $state<string | null>(null);

  $effect(() => {
    const directoryCid = dirCid;
    const npub = route.npub;
    const treeName = route.treeName;
    const path = [...route.path];
    const linkKey = route.params.get('k');
    const isSnapshotRoute = route.params.get('snapshot') === '1';
    const snapshot = permalinkSnapshot.snapshot;
    const currentRootCid = getCurrentRootCid();

    if (!directoryCid?.hash) {
      permalinkHref = null;
      return;
    }

    const fallbackHref = folderCopyHref(directoryCid, copyName);

    // UUID-scoped Drive roots are not legacy npub trees. The directory CID is
    // already the portable immutable snapshot and is available immediately.
    if (npub && isNostrIdentityId(npub)) {
      permalinkHref = fallbackHref;
      return;
    }

    if (isSnapshotRoute) {
      permalinkHref = snapshot
        ? buildTreeEventPermalink(snapshot, path, linkKey)
        : fallbackHref;
      return;
    }

    if (!npub || !treeName) {
      permalinkHref = fallbackHref;
      return;
    }

    if (!currentRootCid?.hash) {
      permalinkHref = fallbackHref;
      return;
    }

    const cached = getCachedTreeEventSnapshot(npub, treeName);
    if (cached && snapshotMatchesRootCid(cached, currentRootCid)) {
      permalinkHref = buildTreeEventPermalink(cached, path, linkKey);
      return;
    }

    // The immutable link works at once; the signed snapshot replaces it when seen.
    permalinkHref = fallbackHref;
    let cancelled = false;
    ensureTreeEventSnapshotForRoot(npub, treeName, currentRootCid).then((snapshot) => {
      if (!cancelled) {
        permalinkHref = snapshot
          ? buildTreeEventPermalink(snapshot, path, linkKey)
          : fallbackHref;
      }
    }).catch(() => {
      if (!cancelled) {
        permalinkHref = fallbackHref;
      }
    });
    return () => { cancelled = true; };
  });

  $effect(() => {
    const snapshot = permalinkSnapshot.snapshot;
    const isSnapshotRoute = route.params.get('snapshot') === '1';
    const path = [...route.path];
    const linkKey = route.params.get('k');

    if (!isSnapshotRoute || !snapshot) {
      latestVersionHref = null;
      return;
    }

    const cached = getCachedTreeEventSnapshot(snapshot.npub, snapshot.treeName);
    if (cached && isNewerTreeEventSnapshot(cached, snapshot)) {
      latestVersionHref = buildTreeEventPermalink(cached, path, linkKey);
      return;
    }

    latestVersionHref = null;
    return watchLatestTreeEventSnapshot(snapshot.npub, snapshot.treeName, (latest) => {
      if (isNewerTreeEventSnapshot(latest, snapshot)) {
        latestVersionHref = buildTreeEventPermalink(latest, path, linkKey);
      }
    });
  });

  // Check if we're in a subdirectory (not root)
  let isSubdir = $derived(route.path.length > 0);
  let currentDirName = $derived(isSubdir ? route.path[route.path.length - 1] : null);

  // For fork and ZIP naming, prefer the caller's directory name so it matches dirCid.
  let forkBaseName = $derived(dirName || currentDirName || route.treeName || 'folder');

  // Suggest a fork name - use dirName unless it already exists as a top-level tree
  function suggestForkName(dirName: string, existingTreeNames: string[]): string {
    if (!existingTreeNames.includes(dirName)) {
      return dirName;
    }
    // Add suffix to find unique name
    let i = 2;
    while (existingTreeNames.includes(`${dirName}-${i}`)) {
      i++;
    }
    return `${dirName}-${i}`;
  }

  // In Drive a folder is copied where it is; Fork is for trees outside Drive.
  let inDrive = $derived(isNostrIdentityId(route.npub ?? ''));
  let folderDepth = $derived(route.path.length - ($isViewingFileStore ? 1 : 0));

  // Handle fork button click
  function handleFork() {
    if (!dirCid) return;
    const suggestedName = suggestForkName(forkBaseName, ownTreeNames);
    openForkModal(dirCid, suggestedName);
  }

  // Handle download as ZIP
  async function handleDownloadZip() {
    if (!dirCid || isDownloading) return;
    isDownloading = true;
    zipAbortController = new AbortController();
    try {
      await downloadFolderZip(dirCid, forkBaseName, zipAbortController.signal);
    } catch (err) {
      console.error('Failed to create ZIP:', err);
      toast.error('Could not make the ZIP file.');
    } finally {
      zipAbortController = null;
      isDownloading = false;
    }
  }

  function handleCancelDownloadZip() {
    zipAbortController?.abort();
  }


  let currentShareUrl = $derived(
    window.location.origin
      + window.location.pathname
      + '#'
      + buildRouteUrl(route.npub, route.treeName, route.path, undefined, route.params.get('k')),
  );
  let shareLinks = $derived.by(() => createDriveShareLinkVariants({
    permalinkUrl: permalinkHref,
    currentUrl: currentShareUrl,
    routeScope: route.npub,
    isPermalink: route.isPermalink,
  }));

  let peopleTarget = $derived(route.isPermalink ? null : sharePeopleTarget({
    scope: route.npub,
    treeName: route.treeName,
    path: route.path,
    profileId: activeNostrIdentityRootScope($nostrStore),
    records: $acceptedShares,
  }));

  let btnClass = 'flex items-center gap-1 px-2.5 h-8 text-xs whitespace-nowrap lg:gap-1.5 lg:px-3 lg:text-sm';

  let menuOpen = $state(false);
  let menuButton: HTMLButtonElement | undefined = $state();

  let menuItems = $derived.by((): MenuItem[] => {
    const items: MenuItem[] = [];
    if (dirCid?.hash && permalinkHref) {
      items.push({ label: 'Read-only copy', icon: dirCid.key ? 'i-lucide-lock' : 'i-lucide-link', testid: 'permalink-link', href: permalinkHref });
    }
    if (dirCid) {
      const cid = dirCid;
      if (canEdit) {
        items.push(isDownloading
          ? { label: 'Cancel ZIP', icon: 'i-lucide-x', testid: 'zip-folder-btn', run: handleCancelDownloadZip }
          : { label: 'Download ZIP', icon: 'i-lucide-download', testid: 'zip-folder-btn', run: () => void handleDownloadZip() });
      }
      if (!inDrive) items.push({ label: 'Fork', icon: 'i-lucide-git-fork', testid: 'fork-folder-btn', run: handleFork });
      else if (canEdit && folderDepth > 0) items.push({ label: 'Make a copy', icon: 'i-lucide-copy', testid: 'make-copy-btn', run: () => void makeCopyOfFolder() });
      items.push({
        label: 'Keep a copy on a server',
        icon: 'i-lucide-upload-cloud',
        testid: 'blossom-push-btn',
        run: () => openBlossomPushModal(cid, forkBaseName, true, route.npub ? (npubToPubkey(route.npub) ?? undefined) : undefined, route.treeName ?? undefined),
      });
    }
    if (canEdit) {
      const name = isSubdir ? currentDirName : null;
      if (name) {
        items.push(
          { label: 'Rename', icon: 'i-lucide-pencil', testid: 'rename-folder-btn', run: () => openRenameModal(name) },
          { label: 'Move', icon: 'i-lucide-folder-input', testid: 'move-folder-btn', run: () => openMoveModal(name, route.path.slice(0, -1)) },
        );
      }
      items.push({ label: 'Delete', icon: 'i-lucide-trash-2', testid: 'delete-folder-btn', run: () => void handleDelete(), danger: true });
    }
    return items;
  });

  async function handleDelete() {
    if (isSubdir && currentDirName) {
      if (confirm(`Delete folder "${currentDirName}" and all its contents?`)) {
        deleteCurrentFolder();
      }
    } else if (route.treeName) {
      if (confirm(`Delete "${route.treeName}"? It will be removed from your folders.`)) {
        await deleteTree(route.treeName);
        window.location.hash = '/';
      }
    }
  }
</script>

{#if dirCid || canEdit}
  <div class="flex shrink-0 items-center gap-1.5 {menuClass}">
    {#if dirCid?.hash}
      {#if latestVersionHref}
        <a href={latestVersionHref} class="btn-ghost no-underline {btnClass}">
          <span class="i-lucide-history text-base"></span>
          See latest version
        </a>
      {/if}
      {#if !canEdit}
        <!-- Someone who was sent a folder mostly wants to take it home. -->
        <button
          onclick={isDownloading ? handleCancelDownloadZip : handleDownloadZip}
          class="btn-ghost {btnClass}"
          title={isDownloading ? 'Cancel ZIP download' : 'Download directory as ZIP'}
        >
          <span class={isDownloading ? 'i-lucide-x' : 'i-lucide-download'}></span>
          {isDownloading ? 'Cancel ZIP' : 'Download ZIP'}
        </button>
      {/if}
      <ShareButton url={shareLinks[0]?.url ?? null} latestUrl={shareLinks[1]?.url ?? null} people={peopleTarget} />
    {/if}

    <div class="relative">
      <button
        bind:this={menuButton}
        onclick={() => { menuOpen = !menuOpen; }}
        class="btn-circle btn-ghost"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="folder-menu-btn"
      >
        <span class="i-lucide-ellipsis text-base"></span>
      </button>
      {#if menuOpen}
        <Menu
          items={menuItems}
          label="More actions"
          inside={[menuButton]}
          testid="folder-menu"
          onClose={(returnFocus) => { menuOpen = false; if (returnFocus) menuButton?.focus(); }}
        />
      {/if}
    </div>
  </div>
{/if}
