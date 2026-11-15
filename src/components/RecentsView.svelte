<script lang="ts">
  /**
   * RecentsView - shows recently accessed files and trees
   */
  import { nip19 } from 'nostr-tools';
  import { recentsStore, clearRecents } from '../stores/recents';
  import { Avatar } from './User';
  import { nostrStore } from '../nostr';
  import { acceptedShares } from '../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { recentDisplay, recentHref, timeAgo } from '../lib/recentDisplay';

  let ownProfileId = $derived(activeNostrIdentityRootScope($nostrStore));
  // My Drive is always one click away in the sidebar; Recent is for what is inside it.
  let recents = $derived($recentsStore.filter((item) => !(item.type === 'tree' && item.treeName === 'main' && item.npub === ownProfileId)));

  function npubToPubkey(npub: string): string | null {
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        return decoded.data as string;
      }
    } catch {}
    return null;
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
          href={recentHref(item)}
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
