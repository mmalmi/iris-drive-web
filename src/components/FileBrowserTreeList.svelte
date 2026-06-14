<script lang="ts">
  import { npubToPubkey } from '../nostr';
  import { open as openCreateModal } from './Modals/CreateModal.svelte';
  import ShareButton from './ShareButton.svelte';
  import SharedWithMePanel from './SharedWithMePanel.svelte';
  import { UserRow } from './User';
  import { TreeRow } from './ui';
  import type { TreeEntry } from '../stores';
  import { buildTreeHref } from './fileBrowserHrefs';

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
    onKeyDown,
    fileListRef = $bindable(),
  }: Props = $props();
</script>

<div class="h-10 shrink-0 px-3 border-b border-surface-2 flex items-center gap-2 bg-surface-0">
  {#if viewedNpub}
    <a href="#/{viewedNpub}/profile" class="no-underline min-w-0">
      <UserRow pubkey={npubToPubkey(viewedNpub) || viewedNpub} avatarSize={24} showBadge class="min-w-0" />
    </a>
  {:else if isLoggedIn && userNpub}
    <a href="#/{userNpub}/profile" class="no-underline min-w-0">
      <UserRow pubkey={npubToPubkey(userNpub) || userNpub} avatarSize={24} showBadge class="min-w-0" />
    </a>
  {:else}
    <span class="text-sm text-text-2">Folders</span>
  {/if}
  <div class="ml-auto">
    <ShareButton url={shareUrl} />
  </div>
</div>

{#if isOwnTrees}
  <button
    onclick={() => openCreateModal('tree')}
    class="shrink-0 mx-3 mt-3 btn-ghost border border-dashed border-surface-2 flex items-center justify-center gap-2 py-3 text-sm text-text-2 hover:text-text-1 hover:border-accent"
  >
    <span class="i-lucide-folder-plus"></span>
    New Folder
  </button>
  <SharedWithMePanel />
{/if}

<div
  bind:this={fileListRef}
  data-testid="file-list"
  class="flex-1 overflow-auto pb-4 outline-none"
  tabindex="0"
  role="listbox"
  aria-label="File list"
  onkeydown={onKeyDown}
>
  {#if sortedTrees.length === 0}
    <div class="p-8 text-center text-muted">Add files to begin</div>
  {:else}
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
  {/if}
</div>
