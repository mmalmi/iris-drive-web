<script lang="ts">
  /**
   * Where you are, above a folder's list, with sharing beside it: the way
   * back, the folders above, the folder's name and who can open it. New is
   * in the sidebar, or here where there is none, and on the folder's name.
   */
  import type { CID, TreeVisibility } from '@hashtree/core';
  import { npubToPubkey } from '../nostr';
  import { UserRow, Avatar } from './User';
  import FolderActions from './FolderActions.svelte';
  import NewMenu from './NewMenu.svelte';
  import { newDestination } from '../stores/newDestination';
  import VisibilityIcon from './VisibilityIcon.svelte';
  import AccessBadge from './AccessBadge.svelte';
  import type { ItemAccess } from '../drive/itemAccess';

  interface Props {
    /** Where "up" leads, if anywhere. */
    parentHref: string | null;
    /** Whose Drive it is, when that is someone's npub. */
    ownerNpub: string | null;
    /** The folders above the open one, outermost first. */
    crumbs: { name: string; href: string }[];
    name: string;
    access: ItemAccess | null;
    visibility: TreeVisibility;
    canEdit: boolean;
    dirCid: CID | null;
    /** The folder's actions, where it can be acted on. */
    showActions: boolean;
  }

  let { parentHref, ownerNpub, crumbs, name, access, visibility, canEdit, dirCid, showActions }: Props = $props();
</script>

<div
  class="shrink-0 h-14 lg:h-16 flex items-center gap-2 sm:gap-3 px-3 py-2 lg:px-5 lg:py-3 border-b border-surface-2 bg-surface-0"
  data-testid="folder-header"
>
  <div class="min-w-0 flex-1 flex items-center gap-1.5 min-h-9">
    {#if parentHref}
      <a
        href={parentHref}
        class="lg:hidden btn-circle btn-ghost shrink-0 no-underline"
        title="Back"
        aria-label="Back"
      >
        <span class="i-lucide-chevron-left text-lg"></span>
      </a>
    {/if}
    {#if ownerNpub}
      <a href="#/{ownerNpub}/profile" class="lg:hidden shrink-0">
        <Avatar pubkey={npubToPubkey(ownerNpub) || ''} size={20} />
      </a>
    {/if}
    <span class="i-lucide-folder-open text-lg lg:text-xl text-warning shrink-0 mr-0.5"></span>
    <nav class="hidden lg:contents" aria-label="Folder path">
      {#if ownerNpub}
        <a href="#/{ownerNpub}/profile" class="min-w-8 shrink-100 no-underline">
          <UserRow pubkey={npubToPubkey(ownerNpub) || ownerNpub} avatarSize={24} class="min-w-0" />
        </a>
        <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
      {/if}
      {#each crumbs as crumb (crumb.href)}
        <a href={crumb.href} class="min-w-8 shrink-100 truncate text-xl text-text-3 no-underline hover:text-text-1">{crumb.name}</a>
        <span class="i-lucide-chevron-right shrink-0 text-text-3"></span>
      {/each}
    </nav>
    <!-- Not clipped where its name opens New, so the menu below it shows whole. -->
    <h1 class="min-w-0 {canEdit ? '' : 'truncate'} text-base lg:text-xl font-medium text-text-1">
      {#if canEdit}<NewMenu variant="name" {name} class="min-w-0" />{:else}{name}{/if}
    </h1>
    {#if access}
      <AccessBadge {access} label class="ml-1" />
    {:else}
      <VisibilityIcon {visibility} class="text-text-3 shrink-0 ml-1" />
    {/if}
  </div>
  {#if canEdit || $newDestination?.inMyDrive}
    <NewMenu variant="folder" goTo={canEdit ? null : $newDestination?.href} inMyDrive={!canEdit} class="shrink-0" />
  {/if}
  {#if showActions}
    <FolderActions
      {dirCid}
      dirName={name}
      {canEdit}
    />
  {/if}
</div>
