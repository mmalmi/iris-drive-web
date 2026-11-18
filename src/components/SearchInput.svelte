<script lang="ts">
  /**
   * Search this Drive: names of files, folders and documents in My Drive and
   * shared folders, and the items opened recently. A pasted Drive link opens.
   */
  import { tick } from 'svelte';
  import { driveSearchHash } from '../lib/driveSearchLink';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { recentsStore } from '../stores/recents';
  import { recentDisplay, recentHref, timeAgo } from '../lib/recentDisplay';
  import { driveRoots, driveScopes } from '../lib/driveRoots';
  import type { DriveSearchRoot, SearchFileType, SearchFolder } from '../lib/driveSearch';
  import { routeStore } from '../stores/route';
  import { isViewingFileStore } from '../stores/currentDirHash';
  import { isDocumentFolderName } from '../lib/documentNames';

  interface Props {
    fullWidth?: boolean;
    autofocus?: boolean;
    onSelect?: () => void;
    placeholder?: string;
  }

  let { fullWidth = false, autofocus = false, onSelect, placeholder = 'Search Drive' }: Props = $props();

  interface Result {
    name: string;
    icon: string;
    href: string;
    detail: string;
  }

  const SHOWN = 12;
  const PAGE_SIZE = 100;

  let inputRef: HTMLInputElement | undefined = $state();
  let containerRef: HTMLDivElement | undefined = $state();
  let value = $state('');
  let focused = $state(false);
  let showDropdown = $state(false);
  let selectedIndex = $state(0);
  let choosingResult = $state(false);
  let searching = $state(false);
  let found = $state.raw<Result[]>([]);
  let search: typeof import('../lib/driveSearch') | null = $state(null);

  let inFolder = $state(false);
  let fileType = $state<SearchFileType | ''>('');
  let allResults = $state(false);
  let more = $state(false);
  let ownProfileId = $derived(activeNostrIdentityRootScope($nostrStore));

  let folder = $derived.by((): SearchFolder | null => {
    const { npub: scope, path, treeName, isPermalink } = $routeStore;
    const me = ownProfileId ?? $nostrStore.npub;
    if (!scope || isPermalink || treeName !== 'main' || !me
      || !driveScopes(ownProfileId, $nostrStore.npub, $acceptedShares).includes(scope)) return null;
    const doc = path.findIndex(isDocumentFolderName);
    const parent = doc >= 0 ? path.slice(0, doc) : $isViewingFileStore ? path.slice(0, -1) : path;
    const nestedShares = scope === me ? $acceptedShares.filter(record => {
      const source = record.folder.source_path?.split('/').filter(Boolean);
      return record.local_profile_id === me && record.folder.owner_profile_id === me && source
        && parent.every((part, index) => source[index] === part);
    }).map(record => record.share_id) : [];
    return { scope, path: parent, nestedShares };
  });
  let location = $derived(inFolder ? folder : null);
  let filtering = $derived(!!value.trim() || !!location || !!fileType);

  export function focus() {
    inputRef?.focus();
  }

  /** My Drive and the shared folders, as far as this device has them now. */
  function currentRoots(): DriveSearchRoot[] {
    return driveRoots(ownProfileId, $nostrStore.npub, $acceptedShares);
  }

  let recents = $derived($recentsStore
    .map((item) => {
      const shown = recentDisplay(item, ownProfileId, $acceptedShares);
      return { name: shown.name, icon: shown.icon, href: recentHref(item), detail: timeAgo(item.timestamp) };
    })
    // Two entries can lead to the same place; it is listed once.
    .filter((item, index, all) => all.findIndex((other) => other.href === item.href) === index));

  function refresh() {
    const query = value.trim().toLowerCase();
    if (!search) return;
    if (!filtering) {
      more = false;
      found = [];
      searching = false;
      return;
    }
    const roots = currentRoots();
    search.startDriveSearch(roots);
    const limit = allResults ? Infinity : SHOWN;
    const within = location;
    const relevant = within ? roots.filter(root => root.scope === within.scope || within.nestedShares.includes(root.scope)) : roots;
    const unread = search.hasMoreFolders(relevant, allResults);
    searching = !search.driveSearchDone(relevant);
    // Finish the scan, but hold the visible rows while someone chooses one.
    if (choosingResult) return;
    const drive = search.searchDrive(relevant, query, limit + 1, { type: fileType, folder: location })
      .map((item) => ({ name: item.name, icon: item.icon, href: item.href, detail: item.where }));
    const hrefs = new Set(drive.map((item) => item.href));
    const recent = location || fileType ? [] : recents.filter((item) => !hrefs.has(item.href) && item.name.toLowerCase().includes(query));
    const matches = [...drive, ...recent];
    more = unread || matches.length > limit;
    found = matches.slice(0, limit);
  }

  let results = $derived(filtering ? found : recents.slice(0, 8));

  // Keep the rendered list small even when a whole Drive matches.
  let pageStart = $derived(Math.floor(Math.min(selectedIndex, Math.max(0, results.length - 1)) / PAGE_SIZE) * PAGE_SIZE);
  let pageResults = $derived(results.slice(pageStart, pageStart + PAGE_SIZE));

  $effect(() => {
    void value;
    void location;
    void fileType;
    void showDropdown;
    void ownProfileId;
    void $nostrStore.npub;
    void $acceptedShares;
    allResults = false;
    selectedIndex = 0;
    choosingResult = false;
  });

  // Load filter controls on focus. Only a query or filter starts the walk.
  $effect(() => {
    if (!showDropdown) return;
    if (!search) {
      void import('../lib/driveSearch').then((module) => { search = module; });
      return;
    }
    refresh();
  });

  // Names arrive while the walk goes on; show them as they come, a frame at a time.
  $effect(() => {
    const module = search;
    if (!module || !showDropdown) return;
    let frame = 0;
    const stop = module.onDriveSearchProgress(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    });
    return () => { stop(); cancelAnimationFrame(frame); };
  });

  $effect(() => {
    if (autofocus && inputRef) inputRef.focus();
  });

  // Close dropdown when clicking outside
  $effect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) showDropdown = false;
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  });

  function finish() {
    value = '';
    found = [];
    searching = false;
    inFolder = false;
    fileType = '';
    allResults = false;
    showDropdown = false;
    inputRef?.blur();
    onSelect?.();
  }

  /** A pasted Drive link or content address opens at once. */
  function navigateTo(input: string): boolean {
    const hash = driveSearchHash(input, window.location.origin);
    if (!hash) return false;
    window.location.hash = hash;
    finish();
    return true;
  }

  function open(result: Result) {
    window.location.hash = result.href;
    finish();
  }

  function handleInput(e: Event) {
    const text = (e.target as HTMLInputElement).value;
    const edit = e as InputEvent;
    if ((edit.inputType === 'insertFromPaste' || (edit.data === text && text.length > 1)) && navigateTo(text)) {
      // A paste can open a link before the value ever reached Svelte state.
      (e.target as HTMLInputElement).value = '';
      return;
    }
    value = text;
    showDropdown = true;
  }

  function highlightResult(index: number) {
    choosingResult = true;
    selectedIndex = index;
  }

  async function selectResult(index: number) {
    highlightResult(index);
    await tick();
    containerRef?.querySelector<HTMLElement>(`[data-result-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && navigateTo(value)) {
      e.preventDefault();
      return;
    }
    if (showDropdown && results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectResult((selectedIndex + 1) % results.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectResult((selectedIndex - 1 + results.length) % results.length);
        return;
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        e.preventDefault();
        open(results[selectedIndex]);
        return;
      }
    }
    if (e.key === 'Escape') {
      showDropdown = false;
      inputRef?.blur();
    }
  }
</script>

<div bind:this={containerRef} class="relative w-full {!fullWidth ? 'max-w-lg' : ''}">
  <div class="flex items-center gap-3 px-4 py-2.5 rounded-full bg-surface-0 ring-1 transition-all {focused ? 'ring-accent shadow-sm' : 'ring-surface-2'}">
    <span class="i-lucide-search text-sm text-muted shrink-0"></span>
    <input
      bind:this={inputRef}
      type="text"
      {value}
      oninput={handleInput}
      onkeydown={handleKeyDown}
      onfocus={() => { focused = true; showDropdown = true; }}
      onblur={() => (focused = false)}
      {placeholder}
      aria-label="Search Drive"
      class="bg-transparent border-none outline-none text-base text-text-1 placeholder:text-muted flex-1 min-w-0"
      data-testid="drive-search-input"
    />
    <span class="i-lucide-loader-2 text-sm text-muted shrink-0 {searching ? 'animate-spin' : 'invisible'}"
      title={searching ? 'Still looking' : undefined} aria-hidden="true"></span>
  </div>

  {#if showDropdown}
    <div class="absolute top-full left-0 right-0 mt-1 bg-surface-0 ring-1 ring-surface-2 rounded-lg shadow-lg z-50 flex flex-col max-h-[min(28rem,65dvh)]" data-testid="drive-search-results">
      <div class="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-surface-2">
        <select aria-label="File type" bind:value={fileType} class="text-sm rounded-md bg-surface-1 px-2 py-1 text-text-2 max-w-full">
          <option value="">All types</option>
          {#each Object.entries(search?.fileTypeLabels ?? {}) as [key, label] (key)}
            <option value={key}>{label}</option>
          {/each}
        </select>
        {#if folder}
          <button type="button" aria-pressed={inFolder} onclick={() => { inFolder = !inFolder; }}
            class="flex items-center gap-1 rounded-md text-sm px-2 py-1 {inFolder ? 'bg-accent/15 text-accent' : 'bg-surface-1 text-text-2 hover:bg-surface-2'}">
            <span class="i-lucide-folder-search" aria-hidden="true"></span>This folder
          </button>
        {/if}
      </div>
      <div class="min-h-0 overflow-auto overscroll-contain py-1">
        {#if !filtering && results.length}
          <div class="px-3 py-1 text-xs font-medium text-text-3">Recent</div>
        {/if}
        {#each pageResults as result, offset (result.href)}
          {@const index = pageStart + offset}
          <button
            onclick={() => open(result)}
            onmouseenter={() => highlightResult(index)}
            onfocus={() => highlightResult(index)}
            onpointerdown={() => highlightResult(index)}
            class="w-full text-left flex items-center gap-3 px-3 py-2 {index === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'}"
            data-result-index={index}
            data-testid="drive-search-result"
          >
            <span class="{result.icon} text-lg shrink-0"></span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-text-1 truncate">{result.name}</span>
              <span class="block text-xs text-text-3 truncate">{result.detail}</span>
            </span>
          </button>
        {:else}
          {#if filtering}
            <div class="px-3 py-2 text-sm text-text-3">{searching ? 'Looking…' : 'Nothing found'}</div>
          {/if}
        {/each}
      </div>
      {#if filtering && more && !allResults}
        <button type="button" class="w-full shrink-0 border-t border-surface-2 py-2 text-sm text-accent hover:bg-surface-1"
          onclick={() => { choosingResult = false; allResults = true; focus(); }}>Show all results</button>
      {:else if allResults && results.length > PAGE_SIZE}
        <div class="flex items-center justify-between px-3 py-1 border-t border-surface-2 text-sm">
          <button type="button" disabled={pageStart === 0} class="p-1 text-accent disabled:opacity-40"
            onclick={() => selectResult(pageStart - PAGE_SIZE)}>Previous</button>
          <span class="text-text-3">{pageStart + 1}–{pageStart + pageResults.length} of {results.length}</span>
          <button type="button" disabled={pageStart + PAGE_SIZE >= results.length} class="p-1 text-accent disabled:opacity-40"
            onclick={() => selectResult(pageStart + PAGE_SIZE)}>Next</button>
        </div>
      {/if}
    </div>
  {/if}
</div>
