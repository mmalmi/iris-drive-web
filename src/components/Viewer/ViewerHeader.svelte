<script lang="ts">
  /**
   * ViewerHeader - Shared header for viewer panel
   * Shows back button, avatar, visibility, and name
   * Used by directory viewer (git repos, regular dirs)
   */
  import type { CID, TreeVisibility } from '@hashtree/core';
  import type { Snippet } from 'svelte';
  import { npubToPubkey } from '../../nostr';
  import { Avatar, Name } from '../User';
  import VisibilityIcon from '../VisibilityIcon.svelte';

  interface Props {
    backUrl: string;
    npub?: string | null;
    isPermalink?: boolean;
    rootCid?: CID | null;
    visibility?: TreeVisibility;
    icon?: string | null;
    name: string;
    contextLabel?: string | null;
    constrained?: boolean;
    showOwnerIdentity?: boolean;
    /** Additional classes for outer container */
    class?: string;
    actions?: Snippet;
    children?: Snippet;
  }

  let {
    backUrl,
    npub = null,
    isPermalink = false,
    rootCid = null,
    visibility,
    icon = null,
    name,
    contextLabel = null,
    constrained = false,
    showOwnerIdentity = false,
    class: className = '',
    actions,
    children,
  }: Props = $props();

  let ownerPubkey = $derived(npubToPubkey(npub || '') || '');
</script>

<div class="shrink-0 border-b border-surface-2">
  <div
    class="px-3 py-2 flex flex-wrap items-center justify-between gap-2 {constrained ? 'mx-auto w-full max-w-7xl' : ''} {className}"
    data-testid="viewer-header"
  >
    <div class="mr-2 flex min-w-0 flex-1 items-center gap-2">
      <a href={backUrl} class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8 no-underline inline-flex items-center justify-center" title="Back">
        <span class="i-lucide-chevron-left text-lg"></span>
      </a>
      <!-- Avatar (for npub routes) or LinkLock/globe (for nhash routes) -->
      {#if npub && !showOwnerIdentity}
        <a href="#/{npub}/profile" class="shrink-0 inline-flex items-center">
          <Avatar pubkey={ownerPubkey} size={20} />
        </a>
      {:else if isPermalink}
        {#if rootCid?.key}
          <!-- LinkLockIcon for encrypted permalink -->
          <span class="relative inline-flex items-center shrink-0 text-text-2" title="Encrypted snapshot link">
            <span class="i-lucide-link"></span>
            <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
          </span>
        {:else}
          <span class="i-lucide-globe text-text-2 shrink-0" title="Public snapshot link"></span>
        {/if}
      {/if}
      <!-- Visibility icon -->
      {#if visibility}
        <VisibilityIcon {visibility} class="text-text-2" />
      {/if}
      <div class="min-w-0 flex flex-1 flex-col">
        {#if contextLabel}
          <span class="truncate text-xs text-text-3 leading-tight" data-testid="viewer-context">{contextLabel}</span>
        {/if}
        <div class="flex min-w-0 items-center gap-2">
          {#if showOwnerIdentity && ownerPubkey}
            <a
              href="#/{npub}/profile"
              class="inline-flex min-w-0 items-center gap-1.5 text-sm text-text-2 hover:opacity-80"
              aria-label="View repo owner profile"
            >
              <Avatar pubkey={ownerPubkey} size={20} showBadge={true} />
              <Name pubkey={ownerPubkey} class="min-w-0 truncate text-text-2 hover:text-accent hover:underline" />
            </a>
            <span class="shrink-0 text-text-3">/</span>
          {/if}
          {#if icon}
            <span class="{icon} shrink-0"></span>
          {/if}
          <span class="font-medium text-text-1 truncate leading-none">{name}</span>
          <!-- Slot for additional content (like LIVE badge) -->
          {#if children}
            {@render children()}
          {/if}
        </div>
      </div>
    </div>
    {#if actions}
      <div class="flex max-w-full min-w-0 items-center justify-end max-sm:w-full max-sm:justify-start">
        {@render actions?.()}
      </div>
    {/if}
  </div>
</div>
