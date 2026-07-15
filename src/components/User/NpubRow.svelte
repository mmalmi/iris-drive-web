<script lang="ts">
  import { npubToPubkey } from '../../nostr';
  import { shortNpub } from '../../utils/format';
  import UserRow from './UserRow.svelte';

  interface Props {
    npub: string;
    description?: string;
    avatarSize?: number;
    showBadge?: boolean;
    class?: string;
  }

  let {
    npub,
    description,
    avatarSize = 36,
    showBadge = true,
    class: className = '',
  }: Props = $props();

  let pubkey = $derived(npubToPubkey(npub));
  let resolvedDescription = $derived(description ?? shortNpub(npub));
</script>

{#if pubkey}
  <UserRow {pubkey} description={resolvedDescription} avatarSize={avatarSize} {showBadge} class={className} />
{:else}
  <div class={`flex items-center gap-3 ${className}`}>
    <span class="i-lucide-user text-text-3"></span>
    <div class="flex flex-col min-w-0">
      <span class="text-sm font-mono truncate">{shortNpub(npub)}</span>
      {#if resolvedDescription && resolvedDescription !== npub}
        <span class="text-xs text-muted truncate">{resolvedDescription}</span>
      {/if}
    </div>
  </div>
{/if}
