<script lang="ts">
  /**
   * Folder actions, used in FileBrowser and Viewer: the share button and a
   * menu of the less common actions. Making and adding things is in NewMenu.
   */
  import { nhashEncode, toHex } from '@hashtree/core';
  import type { CID } from '@hashtree/core';
  import { open as openRenameModal } from './Modals/RenameModal.svelte';
  import { open as openForkModal } from './Modals/ForkModal.svelte';
  import ShareButton from './ShareButton.svelte';
  import { open as openBlossomPushModal } from './Modals/BlossomPushModal.svelte';
  import { npubToPubkey } from '../nostr';
  import { deleteCurrentFolder, buildRouteUrl, getCurrentRootCid } from '../actions';
  import { nostrStore, deleteTree } from '../nostr';
  import { getTree } from '../store';
  import { createZipFromDirectory, downloadBlob, ZipCancelledError } from '../utils/compression';
  import { setUploadProgress } from '../stores/upload';
  import { routeStore, createTreesStore, permalinkSnapshotStore } from '../stores';
  import {
    buildTreeEventPermalink,
    ensureTreeEventSnapshotForRoot,
    watchLatestTreeEventSnapshot,
    getCachedTreeEventSnapshot,
    isNewerTreeEventSnapshot,
    snapshotMatchesRootCid,
  } from '../lib/treeEventSnapshots';
  import { createDriveShareLinkVariants } from '../lib/shareUrls';
  import { acceptedShares } from '../drive/shareLibrary';
  import { sharePeopleTarget } from '../drive/sharePeople';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { isNostrIdentityId } from '../utils/route';

  interface Props {
    dirCid?: CID | null;
    dirName?: string | null;
    canEdit: boolean;
    /** No longer used: making and adding things moved to NewMenu. */
    toolbarClass?: string;
    /** Placement of the share button and the menu within the parent. */
    menuClass?: string;
  }

  let { dirCid = null, dirName = null, canEdit, menuClass = '' }: Props = $props();

  let isDownloading = $state(false);
  let zipAbortController = $state<AbortController | null>(null);

  let route = $derived($routeStore);
  let permalinkSnapshot = $derived($permalinkSnapshotStore);
  let userNpub = $derived($nostrStore.npub);

  // Get user's own trees for fork name suggestions
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

    const fallbackHref = `#/${nhashEncode({
      hash: toHex(directoryCid.hash),
      decryptKey: directoryCid.key ? toHex(directoryCid.key) : undefined,
    })}`;

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
      const tree = getTree();
      const cancel = () => zipAbortController?.abort();
      const zipData = await createZipFromDirectory(tree, dirCid, forkBaseName, (progress) => {
        setUploadProgress({
          current: progress.current,
          total: progress.total,
          fileName: progress.fileName,
          status: 'zipping',
          cancel,
        });
      }, zipAbortController.signal);
      setUploadProgress(null);
      const zipName = `${forkBaseName}.zip`;
      downloadBlob(zipData, zipName, 'application/zip');
    } catch (err) {
      if (err instanceof ZipCancelledError) {
        return;
      }
      console.error('Failed to create ZIP:', err);
      alert('Failed to create ZIP file');
    } finally {
      setUploadProgress(null);
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
  let itemClass = 'flex w-full items-center gap-3 px-4 h-10 border-none bg-transparent text-left text-sm text-text-1 no-underline cursor-pointer hover:bg-surface-2';

  let menuOpen = $state(false);
  let menuRef: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef?.contains(event.target as Node)) menuOpen = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') menuOpen = false;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  async function handleDelete() {
    if (isSubdir && currentDirName) {
      if (confirm(`Delete folder "${currentDirName}" and all its contents?`)) {
        deleteCurrentFolder();
      }
    } else if (route.treeName) {
      if (confirm(`Delete "${route.treeName}"? This will remove it from your tree list.`)) {
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

    <div class="relative" bind:this={menuRef}>
      <button
        onclick={() => { menuOpen = !menuOpen; }}
        class="btn-circle btn-ghost"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        data-testid="folder-menu-btn"
      >
        <span class="i-lucide-ellipsis text-base"></span>
      </button>

      {#if menuOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="absolute right-0 top-full z-30 mt-1 min-w-52 overflow-hidden rounded-xl bg-surface-1 py-1 shadow-lg ring-1 ring-surface-3"
          data-testid="folder-menu"
          onclick={() => { menuOpen = false; }}
        >
          {#if dirCid?.hash && permalinkHref}
            <a
              href={permalinkHref}
              class={itemClass}
              title={toHex(dirCid.hash)}
              data-testid="permalink-link"
            >
              <span class="{dirCid.key ? 'i-lucide-lock' : 'i-lucide-link'} text-base text-text-2"></span>
              Snapshot
            </a>
          {/if}

          {#if dirCid}
            {#if canEdit}
              <button
                onclick={isDownloading ? handleCancelDownloadZip : handleDownloadZip}
                class={itemClass}
                title={isDownloading ? 'Cancel ZIP download' : 'Download directory as ZIP'}
              >
                <span class="{isDownloading ? 'i-lucide-x' : 'i-lucide-download'} text-base text-text-2"></span>
                {isDownloading ? 'Cancel ZIP' : 'Download ZIP'}
              </button>
            {/if}
            <button
              onclick={handleFork}
              class={itemClass}
              title="Fork as new top-level folder"
              data-testid="fork-folder-btn"
            >
              <span class="i-lucide-git-fork text-base text-text-2"></span>
              Fork
            </button>
            <button
              onclick={() => openBlossomPushModal(dirCid!, forkBaseName, true, route.npub ? (npubToPubkey(route.npub) ?? undefined) : undefined, route.treeName ?? undefined)}
              class={itemClass}
              title="Push to file servers"
              data-testid="blossom-push-btn"
            >
              <span class="i-lucide-upload-cloud text-base text-text-2"></span>
              Push
            </button>
          {/if}

          {#if canEdit}
            {#if isSubdir && currentDirName}
              <button onclick={() => openRenameModal(currentDirName!)} class={itemClass} title="Rename">
                <span class="i-lucide-pencil text-base text-text-2"></span>
                Rename
              </button>
            {/if}

            <div class="my-1 border-t border-surface-3"></div>
            <button
              onclick={handleDelete}
              class="{itemClass} text-danger!"
              title="Delete"
              data-testid="delete-folder-btn"
            >
              <span class="i-lucide-trash-2 text-base"></span>
              Delete
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
