<script lang="ts">
  import { npubToPubkey } from '../nostr';
  import { open as openCreateModal } from './Modals/CreateModal.svelte';
  import ShareButton from './ShareButton.svelte';
  import SharedWithMePanel from './SharedWithMePanel.svelte';
  import { UserRow } from './User';
  import { TreeRow } from './ui';
  import type { TreeEntry } from '../stores';
  import { buildTreeHref } from './fileBrowserHrefs';
  import { isNostrIdentityId } from '../utils/route';
  import IdentityName from './User/IdentityName.svelte';

  interface Props {
    viewedNpub: string | null;
    userNpub: string | null;
    isLoggedIn: boolean;
    isOwnTrees: boolean;
    shareUrl: string;
    sortedTrees: TreeEntry[];
    targetNpub: string | null | undefined;
    currentTreeName: string | null;
    treeFocusedIndex: number;
    viewedIdentityAppKeyPubkey: string;
    onKeyDown: (event: KeyboardEvent) => void;
    fileListRef?: HTMLDivElement;
  }

  let {
    viewedNpub,
    userNpub,
    isLoggedIn,
    isOwnTrees,
    shareUrl,
    sortedTrees,
    targetNpub,
    currentTreeName,
    treeFocusedIndex,
    viewedIdentityAppKeyPubkey,
    onKeyDown,
    fileListRef = $bindable(),
  }: Props = $props();

  let viewedNostrIdentityId = $derived(viewedNpub && isNostrIdentityId(viewedNpub) ? viewedNpub : null);
</script>

<div class="h-14 shrink-0 px-4 md:px-5 border-b border-surface-2 flex items-center gap-2 bg-surface-0">
  {#if viewedNpub}
    {#if viewedNostrIdentityId}
      <div class="min-w-0 flex items-center gap-2 text-sm text-text-2" data-testid="drive-profile-root-scope">
        <span class="i-lucide-folder-root shrink-0 text-text-3"></span>
        <IdentityName profileId={viewedNostrIdentityId} appKeyPubkey={viewedIdentityAppKeyPubkey} />
      </div>
    {:else}
      <a href="#/{viewedNpub}/profile" class="no-underline min-w-0">
        <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} showBadge class="min-w-0" />
      </a>
    {/if}
  {:else if isLoggedIn && userNpub}
    <a href="#/{userNpub}/profile" class="no-underline min-w-0">
      <UserRow pubkey={npubToPubkey(userNpub) || userNpub} avatarSize={24} showBadge class="min-w-0" />
    </a>
  {:else}
    <span class="text-xl font-medium text-text-1">My Drive</span>
  {/if}
  <div class="ml-auto">
    <ShareButton url={shareUrl} />
  </div>
</div>

{#if isOwnTrees}
  <button
    onclick={() => openCreateModal('tree')}
    class="md:hidden shrink-0 mx-3 mt-3 btn-ghost border border-dashed border-surface-2 flex items-center justify-center gap-2 py-3 text-sm text-text-2 hover:text-text-1 hover:border-accent"
  >
    <span class="i-lucide-folder-plus"></span>
    New Folder
  </button>
  <div class="md:hidden">
    <SharedWithMePanel />
  </div>
{/if}

<div
  bind:this={fileListRef}
  data-testid="file-list"
  class="flex-1 overflow-auto px-3 md:px-5 pb-5 outline-none"
  tabindex="0"
  role="listbox"
  aria-label="File list"
  onkeydown={onKeyDown}
>
  {#if sortedTrees.length === 0}
    <div class="mt-4 rounded-xl border border-dashed border-surface-2 p-10 text-center text-muted">Add folders or files to begin</div>
  {:else}
    <div class="mt-4 overflow-hidden rounded-xl border border-surface-2">
      <div class="hidden md:grid grid-cols-[minmax(0,1fr)_8rem] gap-3 border-b border-surface-2 bg-surface-1/60 px-4 py-2 text-xs font-medium text-text-3">
        <span>Name</span>
        <span>Access</span>
      </div>
      {#each sortedTrees as tree, idx (tree.name)}
        <TreeRow
          href={buildTreeHref(targetNpub!, tree.name, tree.linkKey)}
          name={tree.name}
          visibility={tree.visibility}
          visibilityPosition="right"
          selected={currentTreeName === tree.name}
          focused={treeFocusedIndex === idx}
        />
      {/each}
    </div>
  {/if}
</div>
