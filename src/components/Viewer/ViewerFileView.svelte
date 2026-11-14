<script lang="ts">
  import { toHex, type CID, type TreeEntry, type TreeVisibility } from '@hashtree/core';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { currentHash, permalinkSnapshotStore } from '../../stores';
  import { decodeAsText, formatBytes, getTree } from '../../store';
  import { deleteEntry } from '../../actions';
  import { nostrStore, npubToPubkey } from '../../nostr';
  import { acceptedShares } from '../../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { itemAccess } from '../../drive/itemAccess';
  import { linkShares, linkTargetAt } from '../../drive/linkShares';
  import AccessBadge from '../AccessBadge.svelte';
  import { getNhashFileUrl } from '../../lib/mediaUrl';
  import { getQueryParamsFromHash } from '../../lib/router.svelte';
  import { open as openBlossomPushModal } from '../Modals/BlossomPushModal.svelte';
  import { open as openRenameModal } from '../Modals/RenameModal.svelte';
  import { open as openMoveModal } from '../Modals/MoveModal.svelte';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import { COPY_NAME_PARAM, createDriveShareLinkVariants } from '../../lib/shareUrls';
  import { TreeRow } from '../ui';
  import Menu, { type MenuItem } from '../ui/Menu.svelte';
  import { downloadFile } from '../../lib/downloadEntry';
  import CodeViewer from './CodeViewer.svelte';
  import FileEditor from './FileEditor.svelte';
  import MediaPlayer from './MediaPlayer.svelte';
  import ZipPreview from './ZipPreview.svelte';
  import { buildPathHref } from '../fileBrowserHrefs';
  import { fileImportFor, openAsDocument } from '../../lib/fileImports';
  import { copiedMessage, copyEntry, copyKind } from '../../lib/driveClipboard';
  import { toast } from '../../stores/toast';

  const FILE_RETRY_DELAY_MS = 1500;
  const FILE_RETRY_MAX = 6;
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'java', 'php', 'sql', 'svelte', 'vue']);

  interface Props {
    entry: TreeEntry | null;
    urlFileName: string;
    isEditing: boolean;
    routePath: string[];
    routeNpub: string | null;
    routeTreeName: string | null;
    routeIsPermalink: boolean;
    linkKey: string | null;
    backUrl: string;
    viewedNpub: string | null;
    targetNpub: string | null;
    currentTreeVisibility?: TreeVisibility;
    rootCid: CID | null;
    canEdit: boolean;
    permalinkUrl: string | null;
    latestVersionUrl: string | null;
    openSiteHref: string;
    filesCount: number;
    prevFile: TreeEntry | null;
    nextFile: TreeEntry | null;
  }

  let {
    entry,
    urlFileName,
    isEditing,
    routePath,
    routeNpub,
    routeTreeName,
    routeIsPermalink,
    linkKey,
    backUrl,
    viewedNpub,
    targetNpub,
    currentTreeVisibility,
    rootCid,
    canEdit,
    permalinkUrl,
    latestVersionUrl,
    openSiteHref,
    filesCount,
    prevFile,
    nextFile,
  }: Props = $props();

  let hash = $derived($currentHash);
  let fileAccess = $derived(routeIsPermalink ? null : itemAccess({
    scope: routeNpub,
    treeName: routeTreeName,
    path: routePath,
    profileId: activeNostrIdentityRootScope($nostrStore),
    appKeyPubkey: $nostrStore.pubkey,
    records: $acceptedShares,
    linkShares: $linkShares,
    treeVisibility: currentTreeVisibility,
  }));
  let fileData = $state<Uint8Array | null>(null);
  let fileContent = $state<string | null>(null);
  let loading = $state(false);
  let showLoading = $state(false);
  let loadingTimer: ReturnType<typeof setTimeout> | null = null;
  let bytesLoaded = $state(0);
  let fileRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let fileRetryAttempts = 0;
  let forceFileRetry = false;
  let fileRetryToken = $state(0);
  let prevEntryCidHash: string | null = null;

  function extensionOf(filename: string): string {
    return filename.split('.').pop()?.toLowerCase() || '';
  }

  let isTextFile = $derived(TEXT_EXTENSIONS.has(extensionOf(urlFileName)));
  let isVideo = $derived(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv'].includes(extensionOf(urlFileName)));
  let isImage = $derived(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(extensionOf(urlFileName)));
  let isAudio = $derived(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(extensionOf(urlFileName)));
  let isPdf = $derived(extensionOf(urlFileName) === 'pdf');
  let isZip = $derived(extensionOf(urlFileName) === 'zip');
  /** A file that can be opened as an Iris document, such as a spreadsheet file (see fileImports.ts). */
  let fileImport = $derived(fileImportFor(urlFileName));
  let opening = $state(false);
  let isMarkdown = $derived(extensionOf(urlFileName) === 'md' || extensionOf(urlFileName) === 'markdown');
  let isFullscreen = $derived(getQueryParamsFromHash(hash).get('fullscreen') === '1');
  let cidKey = $derived(entry?.cid?.hash ? toHex(entry.cid.hash) : urlFileName);
  let effectiveMediaTree = $derived.by(() => {
    if (!routeTreeName || routePath.length < 2) {
      return { treeName: routeTreeName, path: routePath.join('/') };
    }
    const pathWithoutFile = routePath.slice(0, -1);
    return {
      treeName: [routeTreeName, ...pathWithoutFile].join('/'),
      path: routePath[routePath.length - 1] || '',
    };
  });
  let shareLinks = $derived.by(() => createDriveShareLinkVariants({
    permalinkUrl,
    currentUrl: window.location.href,
    routeScope: routeNpub,
    isPermalink: routeIsPermalink,
  }));

  $effect(() => {
    fileRetryToken;
    const currentEntry = entry;
    const entryCidHash = currentEntry?.cid?.hash ? toHex(currentEntry.cid.hash) : null;
    const shouldForce = forceFileRetry;
    forceFileRetry = false;

    if (!shouldForce && entryCidHash && entryCidHash === prevEntryCidHash) return;
    prevEntryCidHash = entryCidHash;
    clearFileTimers();
    fileRetryAttempts = 0;
    fileData = null;
    fileContent = null;
    loading = false;
    showLoading = false;
    bytesLoaded = 0;

    if (!currentEntry || isVideo || isAudio || isImage || isPdf) return;

    loading = true;
    let cancelled = false;
    loadingTimer = setTimeout(() => {
      if (!cancelled && loading) showLoading = true;
    }, 2000);

    (async () => {
      try {
        const tree = getTree();
        const chunks: Uint8Array[] = [];
        for await (const chunk of tree.readFileStream(currentEntry.cid, { prefetch: 5 })) {
          if (cancelled) break;
          chunks.push(chunk);
          bytesLoaded += chunk.length;
        }
        if (cancelled) return;

        const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
        const data = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        fileData = data;
        fileContent = decodeAsText(data);
      } catch {
        // Ignore read errors; permalink retries handle transient empty reads.
      } finally {
        loading = false;
        showLoading = false;
        if (loadingTimer) {
          clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        const expectedSize = currentEntry?.size;
        const isSynthetic = currentEntry?.meta && 'synthetic' in currentEntry.meta;
        const shouldRetryEmpty = bytesLoaded === 0 && fileContent === '' && (isSynthetic || expectedSize !== 0);
        if (!cancelled && routeIsPermalink && ((fileData === null && fileContent === null) || shouldRetryEmpty)) {
          scheduleFileRetry();
        }
      }
    })();

    return () => {
      cancelled = true;
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
    };
  });

  $effect(() => {
    if (!entry && !urlFileName) return;
    if (isEditing) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'CANVAS' || target.isContentEditable) return;

      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        if (isFullscreen) exitFullscreen();
        else {
          (document.activeElement as HTMLElement)?.blur();
          window.location.hash = backUrl.slice(1);
        }
        return;
      }
      if ((key === 'j' || key === 'arrowdown' || key === 'l' || key === 'arrowright') && nextFile) {
        e.preventDefault();
        navigateToFile(nextFile.name);
        return;
      }
      if ((key === 'k' || key === 'arrowup' || key === 'h' || key === 'arrowleft') && prevFile) {
        e.preventDefault();
        navigateToFile(prevFile.name);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  });

  function clearFileTimers() {
    if (loadingTimer) clearTimeout(loadingTimer);
    if (fileRetryTimer) clearTimeout(fileRetryTimer);
    loadingTimer = null;
    fileRetryTimer = null;
  }

  function scheduleFileRetry(): void {
    if (fileRetryTimer || fileRetryAttempts >= FILE_RETRY_MAX) return;
    fileRetryAttempts += 1;
    fileRetryTimer = setTimeout(() => {
      fileRetryTimer = null;
      forceFileRetry = true;
      fileRetryToken += 1;
    }, FILE_RETRY_DELAY_MS);
  }

  function navigateToFile(fileName: string) {
    window.location.hash = buildPathHref({
      path: [...routePath.slice(0, -1), fileName],
      currentNpub: routeNpub,
      currentTreeName: routeTreeName,
      rootCid,
      linkKey,
      snapshot: routeIsPermalink && getQueryParamsFromHash(hash).get('snapshot') === '1'
        ? $permalinkSnapshotStore.snapshot : null,
      rootName: routeIsPermalink ? getQueryParamsFromHash(hash).get(COPY_NAME_PARAM) : null,
    });
  }

  function exitFullscreen() {
    const newHash = window.location.hash
      .replace(/[?&]fullscreen=1/g, '')
      .replace(/\?$/, '')
      .replace(/\?&/, '?');
    window.location.hash = newHash;
  }

  function toggleFullscreen() {
    if (isFullscreen) {
      exitFullscreen();
    } else {
      const currentHash = window.location.hash;
      window.location.hash = currentHash.includes('?') ? `${currentHash}&fullscreen=1` : `${currentHash}?fullscreen=1`;
    }
  }

  function exitEditMode() {
    const hashBase = window.location.hash.split('?')[0];
    const params = new SvelteURLSearchParams(window.location.hash.split('?')[1] || '');
    params.delete('edit');
    const queryString = params.toString();
    window.location.hash = queryString ? `${hashBase}?${queryString}` : hashBase;
  }

  function enterEditMode() {
    const hashBase = window.location.hash.split('?')[0];
    const params = new SvelteURLSearchParams(window.location.hash.split('?')[1] || '');
    params.set('edit', '1');
    window.location.hash = `${hashBase}?${params.toString()}`;
  }

  function handleDelete() {
    if (!entry) return;
    if (confirm(`Delete ${entry.name}?`)) {
      deleteEntry(entry.name);
      const dirPath = routePath.slice(0, -1);
      const parts: string[] = [];
      if (routeNpub && routeTreeName) parts.push(routeNpub, routeTreeName, ...dirPath);
      const linkKeySuffix = linkKey ? `?k=${linkKey}` : '';
      window.location.hash = '#/' + parts.map(encodeURIComponent).join('/') + linkKeySuffix;
    }
  }

  async function handleDownload() {
    if (entry) await downloadFile(entry);
  }

  /** Puts the file on the system clipboard for other apps: a picture, its text, or a link. */
  function handleCopy() {
    if (!entry) return;
    const name = entry.name;
    copyEntry(entry).then(
      kind => toast.success(copiedMessage(kind, name), 2500),
      () => toast.error(`Could not copy ${name}`),
    );
  }

  function handleShare() {
    const [primary, secondary] = shareLinks;
    const general = routeIsPermalink ? null : linkTargetAt({
      scope: routeNpub,
      treeName: routeTreeName,
      path: routePath,
      profileId: activeNostrIdentityRootScope($nostrStore),
      records: $acceptedShares,
    });
    if (primary) openShareModal(primary.url, secondary?.url ?? null, null, true, general);
  }

  function openImport() {
    if (!fileImport) return;
    opening = true;
    void openAsDocument(urlFileName, fileImport.kind).finally(() => { opening = false; });
  }

  // Everything but Download and Share is behind ⋮; on a phone it rises from the bottom.
  let moreOpen = $state(false);
  let moreButton: HTMLButtonElement | undefined = $state();
  let phone = $state(false);
  $effect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => { phone = query.matches; };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  });

  let moreItems = $derived.by((): MenuItem[] => {
    if (!entry) return [];
    const current = entry;
    const kind = copyKind(current);
    const items: MenuItem[] = [];
    if (canEdit && fileImport && !routeIsPermalink) {
      items.push({ label: fileImport.label, icon: 'i-lucide-file-input', testid: 'viewer-menu-open-as-document', run: openImport, disabled: opening, class: 'sm:hidden' });
    }
    if (filesCount > 1 && prevFile && nextFile) {
      const previous = prevFile.name;
      const next = nextFile.name;
      items.push(
        { label: 'Next file', icon: 'i-lucide-chevron-right', testid: 'viewer-menu-next', run: () => navigateToFile(next), class: 'sm:hidden' },
        { label: 'Previous file', icon: 'i-lucide-chevron-left', testid: 'viewer-menu-previous', run: () => navigateToFile(previous), class: 'sm:hidden' },
      );
    }
    if (canEdit && isTextFile) {
      items.push({ label: 'Edit', icon: 'i-lucide-pencil-line', testid: 'viewer-edit', run: enterEditMode, disabled: loading || fileContent === null });
    }
    items.push({
      label: kind === 'picture' ? 'Copy picture' : kind === 'text' ? 'Copy text' : 'Copy link',
      icon: 'i-lucide-clipboard-copy',
      testid: 'viewer-copy',
      run: handleCopy,
    });
    if (permalinkUrl) items.push({ label: 'Read-only copy', icon: rootCid?.key ? 'i-lucide-lock' : 'i-lucide-link', testid: 'viewer-permalink', href: permalinkUrl });
    if (openSiteHref) items.push({ label: 'Open as web page', icon: 'i-lucide-globe', testid: 'viewer-open-site', href: openSiteHref, external: true });
    items.push({ label: 'Full screen', icon: 'i-lucide-maximize', testid: 'viewer-fullscreen', run: toggleFullscreen });
    if (canEdit) {
      items.push(
        { label: 'Save to file servers', icon: 'i-lucide-upload-cloud', testid: 'viewer-push', run: () => openBlossomPushModal(current.cid, current.name, false, routeNpub ? (npubToPubkey(routeNpub) ?? undefined) : undefined, routeTreeName ?? undefined) },
        { label: 'Rename', icon: 'i-lucide-pencil', testid: 'viewer-rename', run: () => openRenameModal(current.name) },
        { label: 'Move', icon: 'i-lucide-folder-input', testid: 'viewer-move', run: () => openMoveModal(current.name, routePath.slice(0, -1)) },
        { label: 'Delete', icon: 'i-lucide-trash-2', testid: 'viewer-delete', run: handleDelete, danger: true },
      );
    }
    return items;
  });
</script>

{#if isEditing}
  {#if entry && loading}
    <div class="flex-1 flex items-center justify-center">
      <span class="i-lucide-loader-2 animate-spin text-2xl text-text-3"></span>
    </div>
  {:else}
    <FileEditor fileName={urlFileName} initialContent={fileContent || ''} onDone={exitEditMode} />
  {/if}
{:else if entry}
  <div class="flex-1 flex flex-col min-h-0 bg-surface-0">
    {#if !isFullscreen}
      <!-- One row on a phone too: the name, Download, Share, and the rest behind ⋮. -->
      <div class="shrink-0 px-2 sm:px-3 py-2 border-b border-surface-2 flex items-center gap-1 sm:gap-2" data-testid="viewer-header">
        <a href={backUrl} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 shrink-0 no-underline" title="Back to folder" aria-label="Back to folder" data-testid="viewer-back">
          <span class="i-lucide-chevron-left text-lg"></span>
        </a>
        <div class="min-w-0 flex-1 flex items-center gap-2">
          <TreeRow
            name={entry.name}
            isFolder={false}
            ownerPubkey={viewedNpub ? npubToPubkey(viewedNpub) : null}
            showHashIcon={routeIsPermalink && !viewedNpub}
            visibility={fileAccess ? undefined : currentTreeVisibility}
            hasKey={!!rootCid?.key}
          />
          <AccessBadge access={fileAccess} label />
        </div>
        {#if canEdit && fileImport && !routeIsPermalink}
          <button
            onclick={openImport}
            class="btn-ghost text-accent shrink-0 max-sm:hidden"
            disabled={opening}
            data-testid="viewer-open-as-document"
          >{fileImport.label}</button>
        {/if}
        {#if latestVersionUrl}
          <a href={latestVersionUrl} class="btn-ghost shrink-0 no-underline flex items-center gap-1.5 max-sm:w-9 max-sm:px-0 max-sm:justify-center" title="See latest version" data-testid="viewer-latest-version">
            <span class="i-lucide-history text-base"></span><span class="max-sm:hidden">See latest version</span>
          </a>
        {/if}
        <!-- Beside the list there is no need; on a phone they are behind ⋮, so the name has room. -->
        {#if filesCount > 1 && prevFile && nextFile}
          <button onclick={() => navigateToFile(prevFile.name)} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 shrink-0 max-sm:hidden lg:hidden" title={`Previous: ${prevFile.name}`} aria-label={`Previous: ${prevFile.name}`}>
            <span class="i-lucide-chevron-left text-base"></span>
          </button>
          <button onclick={() => navigateToFile(nextFile.name)} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 shrink-0 max-sm:hidden lg:hidden" title={`Next: ${nextFile.name}`} aria-label={`Next: ${nextFile.name}`}>
            <span class="i-lucide-chevron-right text-base"></span>
          </button>
        {/if}
        <button
          onclick={handleDownload}
          class="btn-ghost shrink-0 flex items-center gap-1.5 max-sm:w-9 max-sm:px-0 max-sm:justify-center"
          title="Download"
          data-testid="viewer-download"
          disabled={loading && !isVideo}
        >
          <span class="i-lucide-download text-base"></span><span class="max-sm:hidden">Download</span>
        </button>
        <button
          onclick={handleShare}
          class="btn-circle btn-ghost shrink-0"
          title={shareLinks.length > 0 ? 'Share' : 'Preparing share link…'}
          aria-label="Share"
          data-testid="viewer-share"
          disabled={shareLinks.length === 0}
        >
          <span class={shareLinks.length > 0 ? 'i-lucide-share text-base' : 'i-lucide-loader-2 animate-spin text-base'}></span>
        </button>
        <div class="relative shrink-0">
          <button
            bind:this={moreButton}
            onclick={() => { moreOpen = !moreOpen; }}
            class="btn-circle btn-ghost"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-testid="viewer-menu-btn"
          >
            <span class="i-lucide-ellipsis-vertical text-base"></span>
          </button>
          {#if moreOpen}
            <Menu
              items={moreItems}
              label="More actions"
              heading={entry.name}
              sheet={phone}
              inside={[moreButton]}
              testid="viewer-menu"
              onClose={(returnFocus) => { moreOpen = false; if (returnFocus) moreButton?.focus(); }}
            />
          {/if}
        </div>
      </div>
    {/if}

    <div class="flex-1 flex flex-col min-h-0">
      {#if isVideo && entry?.cid}
        {#key urlFileName}
          <MediaPlayer cid={entry.cid} fileName={urlFileName} type="video" npub={targetNpub ?? undefined} treeName={effectiveMediaTree.treeName ?? undefined} path={effectiveMediaTree.path} />
        {/key}
      {:else if isImage && entry?.cid}
        {#key cidKey}
          {@const imageUrl = getNhashFileUrl(entry.cid, urlFileName || 'image')}
          <div class="flex-1 flex items-center justify-center overflow-auto bg-surface-0 p-4">
            {#if isFullscreen}
              <img src={imageUrl} alt={urlFileName} class="max-w-full max-h-full object-contain" data-testid="image-viewer" />
            {:else}
              <button onclick={toggleFullscreen} class="cursor-zoom-in bg-transparent border-none p-0" title="Click to view full size">
                <img src={imageUrl} alt={urlFileName} class="max-w-full object-contain" style="max-height: calc(100vh - 200px);" data-testid="image-viewer" />
              </button>
            {/if}
          </div>
        {/key}
      {:else if isAudio && entry?.cid}
        {#key urlFileName}
          <MediaPlayer cid={entry.cid} fileName={urlFileName} type="audio" npub={targetNpub ?? undefined} treeName={effectiveMediaTree.treeName ?? undefined} path={effectiveMediaTree.path} />
        {/key}
      {:else if isPdf && entry?.cid}
        {#key cidKey}
          <iframe src={getNhashFileUrl(entry.cid, urlFileName || 'document.pdf')} class="flex-1 w-full border-none" title={urlFileName}></iframe>
        {/key}
      {:else if fileImport?.preview && fileData}
        {#key cidKey}
          {#await fileImport.preview() then { default: FilePreview }}
            <FilePreview fileName={urlFileName} data={fileData} />
          {/await}
        {/key}
      {:else if isZip && fileData}
        {#key cidKey}
          <ZipPreview data={fileData} filename={urlFileName} onDownload={handleDownload} />
        {/key}
      {:else if isMarkdown && fileContent !== null}
        {#key cidKey}
          <div class="flex-1 overflow-auto">
            {#await import('./MarkdownViewer.svelte') then { default: MarkdownViewer }}
              <MarkdownViewer content={fileContent} dirPath={routePath.slice(0, -1)} />
            {/await}
          </div>
        {/key}
      {:else}
        {#key cidKey}
          <div class="flex-1 overflow-auto p-4 b-1 b-solid b-transparent">
            {#if showLoading}
              <div class="text-muted animate-fade-in flex flex-col items-start gap-1" data-testid="loading-indicator">
                <span>Loading...</span>
                {#if bytesLoaded > 0}
                  <span class="text-sm opacity-70">{bytesLoaded < 1024 * 1024 ? `${Math.round(bytesLoaded / 1024)}KB` : `${(bytesLoaded / (1024 * 1024)).toFixed(1)}MB`}</span>
                {/if}
              </div>
            {:else if fileContent !== null && urlFileName}
              <CodeViewer content={fileContent} filename={urlFileName} />
            {:else if !loading && entry}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="w-full h-full p-3">
                <div class="w-full h-full flex flex-col items-center justify-center text-accent cursor-pointer hover:bg-accent/10 transition-colors border border-accent/50 rounded-lg" onclick={handleDownload}>
                  <span class="i-lucide-download text-4xl mb-2"></span>
                  <span class="text-sm mb-1">{urlFileName}</span>
                  {#if entry.size}
                    <span class="text-xs text-text-2">{formatBytes(entry.size)}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/key}
      {/if}
    </div>
  </div>
{/if}
