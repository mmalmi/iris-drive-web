<script lang="ts">
  import { toHex, nhashEncode, LinkType } from '@hashtree/core';
  import { routeStore, treeRootStore, currentDirCidStore, directoryEntriesStore, currentHash, createTreesStore, addRecent, isViewingFileStore, resolvingPathStore, permalinkSnapshotStore } from '../../stores';
  import { nostrStore } from '../../nostr';
  import { getQueryParamsFromHash } from '../../lib/router.svelte';
  import DirectoryActions from './DirectoryActions.svelte';
  import ViewerFileView from './ViewerFileView.svelte';
  import YjsDocumentEditor from './YjsDocumentEditor.svelte';
  import { supportsDocumentFeatures } from '../../appType';
  import { buildSitesHref, isHtmlFilename } from '../../lib/siteHref';
  import {
    buildTreeEventPermalink,
    ensureTreeEventSnapshotForRoot,
    ensureLatestTreeEventSnapshot,
    getCachedTreeEventSnapshot,
    isNewerTreeEventSnapshot,
    snapshotMatchesRootCid,
  } from '../../lib/treeEventSnapshots';
  import { isActiveNostrIdentityRouteScope } from '../../drive/profileRoute';
  import { isNostrIdentityId } from '../../utils/route';

  let route = $derived($routeStore);
  let rootCid = $derived($treeRootStore);
  let currentDirCid = $derived($currentDirCidStore);
  let dirEntries = $derived($directoryEntriesStore);
  let entries = $derived(dirEntries.entries);
  let currentDirHashKey = $derived(currentDirCid?.hash ? toHex(currentDirCid.hash) : null);
  let entriesAreStale = $derived(
    currentDirHashKey !== null && dirEntries.loadedHashKey !== currentDirHashKey
  );
  let entriesLoading = $derived(dirEntries.loading || entriesAreStale);
  let hash = $derived($currentHash);
  let permalinkSnapshot = $derived($permalinkSnapshotStore);

  // Check if user can edit (owns the tree or is not viewing another user's tree)
  let userNpub = $derived($nostrStore.npub);
  let isLoggedIn = $derived($nostrStore.isLoggedIn);
  let viewedNpub = $derived(route.npub ?? permalinkSnapshot.snapshot?.npub ?? null);
  let isOwnDriveProfile = $derived(isActiveNostrIdentityRouteScope(viewedNpub, $nostrStore));
  let canEdit = $derived(!viewedNpub || viewedNpub === userNpub || isOwnDriveProfile || !isLoggedIn);

  // Get current tree for visibility info
  let targetNpub = $derived(viewedNpub || userNpub);
  let treesStore = $derived(createTreesStore(targetNpub));
  let trees = $derived($treesStore);
  let currentTreeName = $derived(route.treeName ?? permalinkSnapshot.snapshot?.treeName ?? null);
  let currentTree = $derived(currentTreeName ? trees.find(t => t.name === currentTreeName) : null);

  // Get filename from URL path - uses actual isDirectory check from hashtree
  let urlPath = $derived(route.path);
  let lastSegment = $derived(urlPath.length > 0 ? urlPath[urlPath.length - 1] : null);
  let isViewingFile = $derived($isViewingFileStore);
  let resolvingPath = $derived($resolvingPathStore);
  let hasFile = $derived(isViewingFile && lastSegment);
  let urlFileName = $derived(hasFile ? lastSegment : null);

  // Parse query params from URL hash - use currentHash store for reactivity
  let searchParams = $derived.by(() => {
    return getQueryParamsFromHash(hash);
  });

  let isEditing = $derived(searchParams.get('edit') === '1');

  // Find entry in current entries list, or create synthetic entry for file permalinks
  // Use $state for caching previous entry to avoid flicker during store updates
  let cachedEntry = $state<typeof entries[0] | null>(null);

  // Pure derived that finds entry from current state
  let currentEntry = $derived.by(() => {
    if (!urlFileName) return null;

    // First try to find the file in entries (works for files within directories)
    const fromEntries = entries.find(e => e.name === urlFileName && e.type !== LinkType.Dir);
    if (fromEntries) return fromEntries;

    // For direct file permalinks (no directory listing), the rootCid IS the file's CID
    // Create a synthetic entry since there's no directory listing
    if (route.isPermalink && route.params.get('snapshot') !== '1' && rootCid && entries.length === 0) {
      return {
        name: urlFileName,
        cid: rootCid,
        size: 0,
        type: LinkType.Blob,
        meta: { synthetic: true },
      };
    }

    return null;
  });

  // Update cache when we have a valid entry, clear when filename changes
  $effect(() => {
    if (currentEntry) {
      cachedEntry = currentEntry;
    } else if (cachedEntry && urlFileName !== cachedEntry.name) {
      // Clear cache when navigating to different file
      cachedEntry = null;
    }
  });

  // Use current entry, or fall back to cached entry during transitions
  let entryFromStore = $derived.by(() => {
    if (currentEntry) return currentEntry;
    // Keep cached entry if filename matches (prevents flicker during loading)
    if (cachedEntry && urlFileName && cachedEntry.name === urlFileName) {
      return cachedEntry;
    }
    return null;
  });

  // Get files only (no directories) for prev/next navigation
  let filesOnly = $derived(entries.filter(e => e.type !== LinkType.Dir));
  let currentFileIndex = $derived(urlFileName ? filesOnly.findIndex(e => e.name === urlFileName) : -1);
  // Wrap around at start/end
  let prevFile = $derived(
    filesOnly.length > 1 && currentFileIndex >= 0
      ? filesOnly[(currentFileIndex - 1 + filesOnly.length) % filesOnly.length]
      : null
  );
  let nextFile = $derived(
    filesOnly.length > 1 && currentFileIndex >= 0
      ? filesOnly[(currentFileIndex + 1) % filesOnly.length]
      : null
  );

  // Check if we have a tree context (for showing actions)
  let hasTreeContext = $derived(!!rootCid || !!route.treeName);

  // Check if current directory is a Yjs document (contains .yjs file)
  let isYjsDocument = $derived(supportsDocumentFeatures() && entries.some(e => e.name === '.yjs' && e.type !== LinkType.Dir));

  // Get current directory name from path
  let currentDirName = $derived.by(() => {
    const pathSegments = route.path;
    return pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : route.treeName || 'Document';
  });
  let yjsViewKey = $derived.by(() => {
    if (!route.npub || !route.treeName) return '';
    const pathKey = route.path.join('/');
    const linkKey = route.params.get('k') ?? '';
    return `${route.npub}/${route.treeName}/${pathKey}?k=${linkKey}`;
  });

  // Track file visits in recents
  $effect(() => {
    if (!urlFileName || !route.npub || !route.treeName) return;

    // Build full path for the file
    const pathParts = route.path.join('/');
    const fullPath = `/${route.npub}/${route.treeName}${pathParts ? '/' + pathParts : ''}`;

    addRecent({
      type: 'file',
      label: urlFileName,
      path: fullPath,
      npub: route.npub,
      treeName: route.treeName,
    });
  });

  // Build permalink URL for the current file
  let permalinkUrl = $state<string | null>(null);
  let latestVersionUrl = $state<string | null>(null);
  let isHtml = $derived(urlFileName ? isHtmlFilename(urlFileName) : false);

  $effect(() => {
    const entry = entryFromStore;
    const npub = viewedNpub;
    const treeName = currentTreeName;
    const path = [...route.path];
    const linkKey = route.params.get('k');
    const snapshot = permalinkSnapshot.snapshot;
    const isSnapshotRoute = route.params.get('snapshot') === '1';
    const currentRootCid = rootCid;

    if (!entry?.cid?.hash) {
      permalinkUrl = null;
      return;
    }

    const fallbackHashHex = toHex(entry.cid.hash);
    const fallbackKeyHex = entry.cid.key ? toHex(entry.cid.key) : undefined;
    const fallbackNhash = nhashEncode({ hash: fallbackHashHex, decryptKey: fallbackKeyHex });
    const fallbackUrl = `#/${fallbackNhash}/${encodeURIComponent(entry.name)}`;

    // Profile UUID routes use the newer Drive-root protocol rather than
    // legacy npub tree events. Their file CID is already an immutable,
    // portable revision, so avoid a doomed 20-second legacy snapshot lookup.
    if (npub && isNostrIdentityId(npub)) {
      permalinkUrl = fallbackUrl;
      return;
    }

    if (isSnapshotRoute && snapshot) {
      permalinkUrl = buildTreeEventPermalink(snapshot, path, linkKey);
      return;
    }

    if (!npub || !treeName) {
      permalinkUrl = fallbackUrl;
      return;
    }

    if (!currentRootCid?.hash) {
      permalinkUrl = fallbackUrl;
      return;
    }

    const cached = getCachedTreeEventSnapshot(npub, treeName);
    if (cached && snapshotMatchesRootCid(cached, currentRootCid)) {
      permalinkUrl = buildTreeEventPermalink(cached, path, linkKey);
      return;
    }

    permalinkUrl = null;
    let cancelled = false;
    ensureTreeEventSnapshotForRoot(npub, treeName, currentRootCid).then((resolved) => {
      if (!cancelled) {
        permalinkUrl = resolved
          ? buildTreeEventPermalink(resolved, path, linkKey)
          : fallbackUrl;
      }
    }).catch(() => {
      if (!cancelled) {
        permalinkUrl = fallbackUrl;
      }
    });
    return () => { cancelled = true; };
  });

  $effect(() => {
    const snapshot = permalinkSnapshot.snapshot;
    const path = [...route.path];
    const linkKey = route.params.get('k');
    const isSnapshotRoute = route.params.get('snapshot') === '1';

    if (!isSnapshotRoute || !snapshot) {
      latestVersionUrl = null;
      return;
    }

    const cached = getCachedTreeEventSnapshot(snapshot.npub, snapshot.treeName);
    if (cached && isNewerTreeEventSnapshot(cached, snapshot)) {
      latestVersionUrl = buildTreeEventPermalink(cached, path, linkKey);
      return;
    }

    latestVersionUrl = null;
    let cancelled = false;
    ensureLatestTreeEventSnapshot(snapshot.npub, snapshot.treeName).then((latest) => {
      if (!cancelled && latest && isNewerTreeEventSnapshot(latest, snapshot)) {
        latestVersionUrl = buildTreeEventPermalink(latest, path, linkKey);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  });

  let backUrl = $derived.by(() => {
    if (route.isPermalink && route.params.get('snapshot') === '1' && permalinkSnapshot.snapshot) {
      const parentPath = route.path.slice(0, -1);
      if (parentPath.length > 0) {
        return buildTreeEventPermalink(permalinkSnapshot.snapshot, parentPath, route.params.get('k'));
      }
      return viewedNpub ? `#/${encodeURIComponent(viewedNpub)}` : '#/';
    }
    const dirPath = route.path.slice(0, -1);
    const parts: string[] = [];
    if (route.npub && route.treeName) {
      parts.push(route.npub, route.treeName, ...dirPath);
    }
    const linkKeySuffix = route.params.get('k') ? `?k=${route.params.get('k')}` : '';
    return '#/' + parts.map(encodeURIComponent).join('/') + linkKeySuffix;
  });

  let openSiteHref = $derived.by(() => {
    if (!urlFileName || !isHtml) return '';
    return buildSitesHref({
      route,
      siteRootCid: currentDirCid ?? (route.isPermalink ? rootCid : null),
      siteRootPath: route.path.slice(0, -1),
      entryPath: urlFileName,
      autoReloadMutable: true,
    });
  });

</script>

{#if urlFileName && (isEditing || entryFromStore)}
  <ViewerFileView
    entry={entryFromStore}
    {urlFileName}
    {isEditing}
    routePath={route.path}
    routeNpub={route.npub}
    routeTreeName={route.treeName}
    routeIsPermalink={route.isPermalink}
    linkKey={route.params.get('k')}
    {backUrl}
    {viewedNpub}
    {targetNpub}
    currentTreeVisibility={currentTree?.visibility}
    {rootCid}
    {canEdit}
    {permalinkUrl}
    {latestVersionUrl}
    {openSiteHref}
    filesCount={filesOnly.length}
    {prevFile}
    {nextFile}
  />
{:else if urlFileName}
  <div class="flex-1 flex items-center justify-center bg-surface-0 text-muted">
    {#if resolvingPath || entriesLoading}
      <span class="i-lucide-loader-2 animate-spin text-text-3" aria-label="Loading file"></span>
    {:else}
      <span>File not found</span>
    {/if}
  </div>
{:else if hasTreeContext && isYjsDocument && currentDirCid}
  <!-- Yjs Document view - show Tiptap editor -->
  {#key yjsViewKey}
    <YjsDocumentEditor
      dirCid={currentDirCid}
      dirName={currentDirName}
      entries={entries}
    />
  {/key}
{:else if hasTreeContext && !resolvingPath}
  <!-- Directory view - show DirectoryActions -->
  <div class="flex-1 flex flex-col min-h-0 bg-surface-0">
    <DirectoryActions />
  </div>
{:else if resolvingPath}
  <!-- Resolving path - show empty placeholder to avoid flash of wrong content -->
  <div class="flex-1 flex items-center justify-center bg-surface-0">
  </div>
{:else}
  <!-- No content view -->
  <div class="flex-1 flex items-center justify-center bg-surface-0 text-muted">
    <span>Select a file to view</span>
  </div>
{/if}
