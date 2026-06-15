<script lang="ts">
  /**
   * Shared folder action buttons - used in FileBrowser and Viewer
   * Port of React FolderActions component
   */
  import { nhashEncode, toHex, LinkType } from '@hashtree/core';
  import type { CID } from '@hashtree/core';
  import { open as openCreateModal } from './Modals/CreateModal.svelte';
  import { open as openRenameModal } from './Modals/RenameModal.svelte';
  import { open as openForkModal } from './Modals/ForkModal.svelte';
  import ShareButton from './ShareButton.svelte';
  import { open as openBlossomPushModal } from './Modals/BlossomPushModal.svelte';
  import { npubToPubkey } from '../nostr';
  import { uploadFiles, uploadDirectory } from '../stores/upload';
  import { deleteCurrentFolder, buildRouteUrl, getCurrentRootCid } from '../actions';
  import { nostrStore, autosaveIfOwn, deleteTree } from '../nostr';
  import { getTree } from '../store';
  import { createZipFromDirectory, downloadBlob, ZipCancelledError } from '../utils/compression';
  import { setUploadProgress } from '../stores/upload';
  import { readFilesFromWebkitDirectory, supportsDirectoryUpload } from '@iris/hashtree-app/directory';
  import { routeStore, createTreesStore, permalinkSnapshotStore } from '../stores';
  import { supportsDocumentFeatures } from '../appType';
  import {
    buildTreeEventPermalink,
    ensureTreeEventSnapshotForRoot,
    ensureLatestTreeEventSnapshot,
    getCachedTreeEventSnapshot,
    isNewerTreeEventSnapshot,
    snapshotMatchesRootCid,
  } from '../lib/treeEventSnapshots';

  interface Props {
    dirCid?: CID | null;
    dirName?: string | null;
    canEdit: boolean;
  }

  let { dirCid = null, dirName = null, canEdit }: Props = $props();

  let isDownloading = $state(false);
  let zipAbortController = $state<AbortController | null>(null);
  let dirInputRef: HTMLInputElement | undefined = $state();

  let hasDirectorySupport = supportsDirectoryUpload();
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

    permalinkHref = null;
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
    let cancelled = false;
    ensureLatestTreeEventSnapshot(snapshot.npub, snapshot.treeName).then((latest) => {
      if (!cancelled && latest && isNewerTreeEventSnapshot(latest, snapshot)) {
        latestVersionHref = buildTreeEventPermalink(latest, path, linkKey);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
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

  // Handle file upload
  function handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) uploadFiles(input.files);
    input.value = '';
  }

  // Handle directory upload
  function handleDirUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const result = readFilesFromWebkitDirectory(input.files);
      uploadDirectory(result);
    }
    input.value = '';
  }

  // Build stream URL - goes to directory with ?stream=1
  let streamUrl = $derived.by(() => {
    const streamQueryParams = [
      route.params.get('k') ? `k=${route.params.get('k')}` : '',
      'stream=1',
    ].filter(Boolean).join('&');
    return route.npub && route.treeName
      ? `#/${route.npub}/${route.treeName}${route.path.length ? '/' + route.path.join('/') : ''}?${streamQueryParams}`
      : null;
  });

  let btnClass = 'flex items-center gap-1 px-2 h-7 text-xs lg:px-3 lg:h-9 lg:text-sm';
</script>

{#if dirCid || canEdit}
  <div class="flex flex-row flex-wrap items-center gap-1">
    <!-- Share and permalink first -->
    {#if dirCid?.hash}
      {@const shareUrl = route.isPermalink
        ? window.location.href
        : window.location.origin + window.location.pathname + '#' + buildRouteUrl(route.npub, route.treeName, route.path, undefined, route.params.get('k'))}
      <ShareButton url={shareUrl} />
      {#if permalinkHref}
        <a
          href={permalinkHref}
          class="btn-ghost no-underline {btnClass}"
          title={toHex(dirCid.hash)}
          data-testid="permalink-link"
        >
          <span class={dirCid.key ? "i-lucide-lock text-base" : "i-lucide-link text-base"}></span>
          Snapshot
        </a>
      {/if}
      {#if latestVersionHref}
        <a href={latestVersionHref} class="btn-ghost no-underline {btnClass}">
          <span class="i-lucide-history text-base"></span>
          See latest version
        </a>
      {/if}
    {/if}

    <!-- Edit actions -->
    {#if canEdit}
      <label class="btn-success cursor-pointer {btnClass}" title="Add files">
        <span class="i-lucide-plus"></span>
        Add
        <input
          type="file"
          multiple
          onchange={handleFileUpload}
          class="hidden"
        />
      </label>

      {#if hasDirectorySupport}
        <label class="btn-ghost cursor-pointer {btnClass}" title="Add a folder with all its contents">
          <span class="i-lucide-folder-plus"></span>
          Add Folder
          <input
            bind:this={dirInputRef}
            type="file"
            webkitdirectory
            onchange={handleDirUpload}
            class="hidden"
          />
        </label>
      {/if}

      <button onclick={() => openCreateModal('file')} class="btn-ghost {btnClass}" title="New File">
        <span class="i-lucide-file-plus"></span>
        New File
      </button>

      <button
        onclick={() => openCreateModal('folder')}
        class="btn-ghost {btnClass}"
        title="New Folder"
      >
        <span class="i-lucide-folder-plus"></span>
        New Folder
      </button>

      {#if supportsDocumentFeatures()}
        <button onclick={() => openCreateModal('document')} class="btn-ghost {btnClass}" title="New Document">
          <span class="i-lucide-file-text"></span>
          New Document
        </button>
      {/if}

      {#if streamUrl}
        <a href={streamUrl} class="btn-ghost no-underline {btnClass}" title="Stream">
          <span class="i-lucide-video"></span>
          Stream
        </a>
      {/if}

      {#if isSubdir && currentDirName}
        <button onclick={() => openRenameModal(currentDirName!)} class="btn-ghost {btnClass}" title="Rename">
          <span class="i-lucide-pencil"></span>
          Rename
        </button>
      {/if}

      <button
        onclick={async () => {
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
        }}
        class="btn-ghost text-danger {btnClass}"
        title="Delete"
        data-testid="delete-folder-btn"
      >
        <span class="i-lucide-trash-2"></span>
        Delete
      </button>
    {/if}

    <!-- Secondary actions: ZIP, Fork -->
    {#if dirCid}
      <button
        onclick={isDownloading ? handleCancelDownloadZip : handleDownloadZip}
        class="btn-ghost {btnClass}"
        title={isDownloading ? 'Cancel ZIP download' : 'Download directory as ZIP'}
      >
        <span class={isDownloading ? "i-lucide-x" : "i-lucide-archive"}></span>
        {isDownloading ? 'Cancel ZIP' : 'ZIP'}
      </button>
      <button
        onclick={handleFork}
        class="btn-ghost {btnClass}"
        title="Fork as new top-level folder"
        data-testid="fork-folder-btn"
      >
        <span class="i-lucide-git-fork"></span>
        Fork
      </button>
      <button
        onclick={() => openBlossomPushModal(dirCid!, forkBaseName, true, route.npub ? (npubToPubkey(route.npub) ?? undefined) : undefined, route.treeName ?? undefined)}
        class="btn-ghost {btnClass}"
        title="Push to file servers"
        data-testid="blossom-push-btn"
      >
        <span class="i-lucide-upload-cloud"></span>
        Push
      </button>
    {/if}
  </div>
{/if}
