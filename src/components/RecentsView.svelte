<script lang="ts">
  /**
   * RecentsView - shows recently accessed files and trees
   */
  import { nip19 } from 'nostr-tools';
  import { recentsStore, clearRecents, type RecentItem } from '../stores/recents';
  import { Avatar } from './User';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { recentDisplay, timeAgo } from '../lib/recentDisplay';

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
        {@const shown = recentDisplay(item, ownProfileId, $acceptedShares)}
        <a
          href={buildHref(item)}
          class="p-3 lg:px-5 border-b border-surface-2 flex items-center gap-3 no-underline text-text-1 hover:bg-surface-2/50 {item.type === 'hash' ? 'font-mono' : ''}"
        >
          {#if ownerPubkey}
            <Avatar pubkey={ownerPubkey} size={20} class="shrink-0" />
          {/if}
          <span class="shrink-0 {shown.icon}"></span>
          <span class="truncate flex-1 min-w-0" title={shown.name}>{shown.name}</span>
          <span class="shrink-0 text-sm text-muted">{timeAgo(item.timestamp)}</span>
        </a>
      {/each}
    {/if}
  </div>
</div>
