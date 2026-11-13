<script lang="ts">
  /**
   * RecentsView - shows recently accessed files and trees
   */
  import { nip19 } from 'nostr-tools';
  import { recentsStore, clearRecents, type RecentItem } from '../stores/recents';
  import { getFileIcon } from '@iris/hashtree-app/fileIcon';
  import { Avatar } from './User';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { documentKindInfo, documentTitle, isDocumentFolderName } from '../lib/documentNames';

  let recents = $derived($recentsStore);
  let ownProfileId = $derived(activeNostrIdentityRootScope($nostrStore));

  function npubToPubkey(npub: string): string | null {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        return decoded.data as string;
      }
    } catch {}
    return null;
  }

  function isDocument(item: RecentItem): boolean {
    return isDocumentFolderName(item.path.split('/').at(-1) ?? '');
  }

  /** A Drive's own top folder is known by its name to people, not by its address. */
  function displayName(item: RecentItem): string {
    if (isDocument(item)) return documentTitle(item.path.split('/').at(-1)!);
    if (item.type === 'tree' && item.treeName === 'main' && item.npub) {
      if (item.npub === ownProfileId) return 'My Drive';
      const shared = $acceptedShares.find((record) => record.share_id === item.npub);
      if (shared) return shared.folder.display_name;
    }
    return item.label;
  }

  function iconClass(item: RecentItem): string {
    if (isDocument(item)) return documentKindInfo(item.path.split('/').at(-1))!.icon;
    if (item.type === 'tree' && item.treeName === 'main' && item.npub === ownProfileId) return 'i-lucide-hard-drive text-text-2';
    if (isFolder(item)) return 'i-lucide-folder text-warning';
    return `${getFileIcon(item.label)} text-text-2`;
  }

  function formatTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  function isFolder(item: RecentItem): boolean {
    return item.type === 'tree' || item.type === 'dir' || item.type === 'hash';
  }

  function buildHref(item: RecentItem): string {
    // Encode treeName in path: /npub/treeName -> /npub/encodedTreeName
    // For files, use the full path which includes the file
    let encodedPath: string;
    if (item.type === 'file' && item.path) {
      // Files use the full path (includes file name)
      // Extract parts and encode properly: /npub/treeName/path/to/file
      const pathParts = item.path.split('/').filter(Boolean);
      if (pathParts.length >= 2) {
        const npub = pathParts[0];
        const rest = pathParts.slice(1).map(p => encodeURIComponent(p)).join('/');
        encodedPath = `/${npub}/${rest}`;
      } else {
        encodedPath = item.path;
      }
    } else if (item.treeName) {
      encodedPath = `/${item.npub}/${encodeURIComponent(item.treeName)}`;
    } else {
      encodedPath = item.path;
    }
    const base = `#${encodedPath}`;
    return item.linkKey ? `${base}?k=${item.linkKey}` : base;
  }
</script>

<div class="flex-1 flex flex-col min-h-0" data-testid="recents-view">
  <div class="shrink-0 flex min-h-13 items-center gap-2 border-b border-surface-2 px-3 py-2 lg:px-5 lg:py-3">
    <span class="i-lucide-clock-3 text-lg lg:text-xl text-accent shrink-0"></span>
    <h1 class="text-base lg:text-xl font-medium text-text-1">Recent</h1>
    {#if recents.length > 0}
      <button
        class="ml-auto btn-ghost flex items-center gap-1.5 px-3 h-8 text-xs lg:text-sm"
        onclick={() => clearRecents()}
        title="Clear recents"
      >
        Clear
      </button>
    {/if}
  </div>
  <div class="flex-1 overflow-auto">
    {#if recents.length === 0}
      <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-3">
        <span class="i-lucide-clock-3 text-4xl"></span>
        Files and folders you open show up here.
      </div>
    {:else}
      {#each recents as item (item.path)}
        {@const ownerPubkey = item.npub ? npubToPubkey(item.npub) : null}
        <a
          href={buildHref(item)}
          class="p-3 lg:px-5 border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {item.type === 'hash' ? 'font-mono' : ''}"
        >
          {#if ownerPubkey}
            <Avatar pubkey={ownerPubkey} size={20} class="shrink-0" />
          {/if}
          <span class="shrink-0 {item.type === 'hash' ? 'i-lucide-hash text-accent' : iconClass(item)}"></span>
          <span class="truncate flex-1 min-w-0" title={displayName(item)}>{displayName(item)}</span>
          <span class="shrink-0 text-sm text-muted">{formatTime(item.timestamp)}</span>
        </a>
      {/each}
    {/if}
  </div>
</div>
