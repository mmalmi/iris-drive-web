<script lang="ts">
  import { toHex, type CID, type TreeEntry, type TreeVisibility } from '@hashtree/core';
  import { SvelteURLSearchParams } from 'svelte/reactivity';
  import { currentHash, recentlyChangedFiles } from '../../stores';
  import { decodeAsText, formatBytes, getTree } from '../../store';
  import { deleteEntry } from '../../actions';
  import { npubToPubkey } from '../../nostr';
  import { getNhashFileUrl } from '../../lib/mediaUrl';
  import { getQueryParamsFromHash } from '../../lib/router.svelte';
  import { open as openBlossomPushModal } from '../Modals/BlossomPushModal.svelte';
  import { open as openRenameModal } from '../Modals/RenameModal.svelte';
  import { open as openShareModal } from '../Modals/ShareModal.svelte';
  import { TreeRow } from '../ui';
  import CodeViewer from './CodeViewer.svelte';
  import FileEditor from './FileEditor.svelte';
  import MarkdownViewer from './MarkdownViewer.svelte';
  import MediaPlayer from './MediaPlayer.svelte';
  import ZipPreview from './ZipPreview.svelte';

  const FILE_RETRY_DELAY_MS = 1500;
  const FILE_RETRY_MAX = 6;
  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'java', 'php', 'sql', 'svelte', 'vue']);
  const MIME_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
  };

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

  function getMimeType(filename?: string): string | null {
    if (!filename) return null;
    return MIME_TYPES[extensionOf(filename)] || null;
  }

  let isTextFile = $derived(TEXT_EXTENSIONS.has(extensionOf(urlFileName)));
  let isVideo = $derived(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv'].includes(extensionOf(urlFileName)));
  let isImage = $derived(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'].includes(extensionOf(urlFileName)));
  let isAudio = $derived(['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(extensionOf(urlFileName)));
  let isPdf = $derived(extensionOf(urlFileName) === 'pdf');
  let isZip = $derived(extensionOf(urlFileName) === 'zip');
  let isMarkdown = $derived(extensionOf(urlFileName) === 'md' || extensionOf(urlFileName) === 'markdown');
  let isFullscreen = $derived(getQueryParamsFromHash(hash).get('fullscreen') === '1');
  let recentlyChanged = $derived($recentlyChangedFiles);
  let isLiveStream = $derived(getQueryParamsFromHash(hash).get('live') === '1' || recentlyChanged.has(urlFileName));
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

  $effect(() => {
    if (typeof window !== 'undefined') {
      const w = window as typeof window & {
        __viewerMediaPlayerTreeName?: string | null;
        __viewerUrlPath?: string[];
      };
      w.__viewerMediaPlayerTreeName = effectiveMediaTree.treeName;
      w.__viewerUrlPath = routePath;
    }
  });

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
    const dirPath = routePath.slice(0, -1);
    const parts: string[] = [];
    if (routeNpub && routeTreeName) parts.push(routeNpub, routeTreeName, ...dirPath, fileName);
    const linkKeySuffix = linkKey ? `?k=${linkKey}` : '';
    window.location.hash = '/' + parts.map(encodeURIComponent).join('/') + linkKeySuffix;
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
    if (!entry) return;
    const tree = getTree();
    const mimeType = getMimeType(urlFileName) || 'application/octet-stream';
    const fileName = entry.name;

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{
            description: 'File',
            accept: { [mimeType]: ['.' + (fileName.split('.').pop() || '')] },
          }],
        });
        const writable = await handle.createWritable();
        for await (const chunk of tree.readFileStream(entry.cid, { prefetch: 5 })) {
          await writable.write(chunk as BufferSource);
        }
        await writable.close();
        return;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.warn('File System Access API failed, falling back to blob:', err);
      }
    }

    const baseUrl = getNhashFileUrl(entry.cid, fileName);
    const separator = baseUrl.includes('?') ? '&' : '?';
    window.location.href = `${baseUrl}${separator}download=1`;
  }

  function handleShare() {
    openShareModal(window.location.href.replace(/[?&]edit=1/, ''));
  }
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
      <div class="shrink-0 px-3 py-2 border-b border-surface-2 flex flex-wrap items-center justify-between gap-2" data-testid="viewer-header">
        <div class="mx-auto flex w-full items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <a href={backUrl} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 no-underline" title="Back to folder" data-testid="viewer-back">
              <span class="i-lucide-chevron-left text-lg"></span>
            </a>
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <TreeRow
                  name={entry.name}
                  isFolder={false}
                  ownerPubkey={viewedNpub ? npubToPubkey(viewedNpub) : null}
                  showHashIcon={routeIsPermalink && !viewedNpub}
                  visibility={currentTreeVisibility}
                  hasKey={!!rootCid?.key}
                />
                {#if isLiveStream}
                  <span class="ml-2 px-1.5 py-0.5 text-xs font-bold bg-red-600 text-white rounded animate-pulse">LIVE</span>
                {/if}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1 flex-wrap">
            <button onclick={handleDownload} class="btn-ghost" title="Download file" data-testid="viewer-download" disabled={loading && !isVideo}>Download</button>
            {#if permalinkUrl}
              <a href={permalinkUrl} class="btn-ghost no-underline" title={entry?.cid?.hash ? toHex(entry.cid.hash) : ''} data-testid="viewer-permalink">Snapshot</a>
            {/if}
            {#if latestVersionUrl}
              <a href={latestVersionUrl} class="btn-ghost no-underline" data-testid="viewer-latest-version">See latest version</a>
            {/if}
            {#if openSiteHref}
              <a href={openSiteHref} target="_blank" rel="noreferrer" class="btn-ghost no-underline" data-testid="viewer-open-site">Open Site</a>
            {/if}
            <button onclick={toggleFullscreen} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} data-testid="viewer-fullscreen">
              <span class={isFullscreen ? 'i-lucide-minimize text-base' : 'i-lucide-maximize text-base'}></span>
            </button>
            <button onclick={handleShare} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8" title="Share" data-testid="viewer-share">
              <span class="i-lucide-share text-base"></span>
            </button>
            {#if entry?.cid}
              <button
                onclick={() => openBlossomPushModal(entry.cid, entry.name, false, routeNpub ? (npubToPubkey(routeNpub) ?? undefined) : undefined, routeTreeName ?? undefined)}
                class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8"
                title="Push to file servers"
                data-testid="viewer-push"
              >
                <span class="i-lucide-upload-cloud text-base"></span>
              </button>
            {/if}
            {#if canEdit}
              <button onclick={() => openRenameModal(entry.name)} class="btn-ghost" data-testid="viewer-rename">Rename</button>
              {#if isTextFile}
                <button onclick={enterEditMode} class="btn-ghost" disabled={loading || fileContent === null} data-testid="viewer-edit">Edit</button>
              {/if}
              <button onclick={handleDelete} class="btn-ghost text-danger" data-testid="viewer-delete">Delete</button>
            {/if}
            {#if filesCount > 1 && prevFile && nextFile}
              <button onclick={() => navigateToFile(prevFile.name)} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 lg:hidden" title={`Previous: ${prevFile.name}`}>
                <span class="i-lucide-chevron-left text-base"></span>
              </button>
              <button onclick={() => navigateToFile(nextFile.name)} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 lg:hidden" title={`Next: ${nextFile.name}`}>
                <span class="i-lucide-chevron-right text-base"></span>
              </button>
            {/if}
          </div>
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
      {:else if isZip && fileData}
        {#key cidKey}
          <ZipPreview data={fileData} filename={urlFileName} onDownload={handleDownload} />
        {/key}
      {:else if isMarkdown && fileContent !== null}
        {#key cidKey}
          <div class="flex-1 overflow-auto">
            <MarkdownViewer content={fileContent} dirPath={routePath.slice(0, -1)} />
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
