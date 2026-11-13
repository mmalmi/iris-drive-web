<script lang="ts">
  /**
   * Search this Drive: names of files, folders and documents in My Drive and
   * shared folders, and the items opened recently. A pasted Drive link opens.
   */
  import { nhashEncode, isNHash, isNPath } from '@hashtree/core';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { getTreeRootSync } from '../stores/treeRoot';
  import { recentsStore } from '../stores/recents';
  import { recentDisplay, recentHref, timeAgo } from '../lib/recentDisplay';
  import type { DriveSearchRoot } from '../lib/driveSearch';

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

  // Match 64 hex chars optionally followed by /filename
  const HASH_PATTERN = /^([a-f0-9]{64})(\/.*)?$/i;
  const SHOWN = 12;

  let inputRef: HTMLInputElement | undefined = $state();
  let containerRef: HTMLDivElement | undefined = $state();
  let value = $state('');
  let focused = $state(false);
  let showDropdown = $state(false);
  let selectedIndex = $state(0);
  let searching = $state(false);
  let found = $state<Result[]>([]);
  let search: typeof import('../lib/driveSearch') | null = $state(null);

  let ownProfileId = $derived(activeNostrIdentityRootScope($nostrStore));

  /** My Drive and the shared folders, as far as this device has them now. */
  function currentRoots(): DriveSearchRoot[] {
    const scope = ownProfileId ?? $nostrStore.npub;
    const shares = $acceptedShares.filter((record) => !ownProfileId || record.local_profile_id === ownProfileId);
    const roots: DriveSearchRoot[] = [];
    const ownCid = scope ? getTreeRootSync(scope, 'main') : null;
    if (scope && ownCid) {
      const sharedOut = shares
        .filter((record) => record.folder.owner_profile_id === ownProfileId && record.folder.source_path)
        .map((record) => record.folder.source_path);
      roots.push({ scope, label: 'My Drive', cid: ownCid, skip: sharedOut });
    }
    for (const record of shares) {
      const cid = getTreeRootSync(record.share_id, 'main');
      if (cid) roots.push({ scope: record.share_id, label: record.folder.display_name, cid, shared: true });
    }
    return roots;
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
    if (!query) {
      found = [];
      searching = false;
      return;
    }
    if (!search) {
      searching = true;
      return;
    }
    const roots = currentRoots();
    // A tree that changed since the last look is read again.
    search.startDriveSearch(roots);
    const drive = search.searchDrive(roots, query, SHOWN).map((item) => ({ name: item.name, icon: item.icon, href: item.href, detail: item.where }));
    const hrefs = new Set(drive.map((item) => item.href));
    const recent = recents.filter((item) => !hrefs.has(item.href) && item.name.toLowerCase().includes(query));
    found = [...drive, ...recent].slice(0, SHOWN);
    searching = !search.driveSearchDone(roots);
  }

  let results = $derived(value.trim() ? found : recents.slice(0, 8));

  // The search code and the walk start the first time the box is used.
  function begin() {
    if (search) {
      search.startDriveSearch(currentRoots());
      refresh();
      return;
    }
    void import('../lib/driveSearch').then((module) => {
      search = module;
      refresh();
      module.startDriveSearch(currentRoots());
    });
  }

  // Names arrive while the walk goes on; show them as they come, a frame at a time.
  $effect(() => {
    const module = search;
    if (!module) return;
    let frame = 0;
    const stop = module.onDriveSearchProgress(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    });
    return () => { stop(); cancelAnimationFrame(frame); };
  });

  // Reset selection when results change
  $effect(() => {
    void results;
    selectedIndex = 0;
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
    showDropdown = false;
    inputRef?.blur();
    onSelect?.();
  }

  /** A pasted Drive link or content address opens at once. */
  function navigateTo(input: string): boolean {
    const trimmed = input.trim();
    let hash: string | null = null;
    try {
      const url = new URL(trimmed);
      if (url.hash.startsWith('#/')) hash = url.hash;
    } catch {
      // Not a URL
    }
    if (!hash && trimmed.startsWith('#/')) hash = trimmed;
    if (!hash && (isNHash(trimmed) || isNPath(trimmed))) hash = `#/${trimmed}`;
    const hashMatch = hash ? null : trimmed.match(HASH_PATTERN);
    if (hashMatch) hash = `#/${nhashEncode(hashMatch[1]!)}${hashMatch[2] || ''}`;
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
    if (navigateTo(text)) return;
    value = text;
    showDropdown = true;
    refresh();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (showDropdown && results.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % results.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        return;
      }
      if (e.key === 'Enter' && results[selectedIndex]) {
        e.preventDefault();
        open(results[selectedIndex]);
        return;
      }
    }
    if (e.key === 'Enter') {
      navigateTo(value);
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
      onfocus={() => { focused = true; showDropdown = true; begin(); }}
      onblur={() => (focused = false)}
      {placeholder}
      aria-label="Search Drive"
      class="bg-transparent border-none outline-none text-base text-text-1 placeholder:text-muted flex-1 min-w-0"
      data-testid="drive-search-input"
    />
    {#if searching}
      <span class="i-lucide-loader-2 animate-spin text-sm text-muted shrink-0" title="Still looking"></span>
    {/if}
  </div>

  {#if showDropdown && (results.length > 0 || value.trim())}
    <div class="absolute top-full left-0 right-0 mt-1 bg-surface-0 ring-1 ring-surface-2 rounded-lg shadow-lg z-50 max-h-96 overflow-auto py-1" data-testid="drive-search-results">
      {#if !value.trim()}
        <div class="px-3 pt-1 pb-1 text-xs font-medium text-text-3">Recent</div>
      {/if}
      {#each results as result, index (result.href)}
        <button
          onclick={() => open(result)}
          onmouseenter={() => (selectedIndex = index)}
          class="w-full text-left flex items-center gap-3 px-3 py-2 {index === selectedIndex ? 'bg-surface-2' : 'hover:bg-surface-1'}"
          data-testid="drive-search-result"
        >
          <span class="{result.icon} text-lg shrink-0"></span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm text-text-1 truncate">{result.name}</span>
            <span class="block text-xs text-text-3 truncate">{result.detail}</span>
          </span>
        </button>
      {:else}
        <div class="px-3 py-2 text-sm text-text-3">{searching ? 'Looking…' : 'Nothing found'}</div>
      {/each}
    </div>
  {/if}
</div>
