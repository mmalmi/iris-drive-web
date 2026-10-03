<script lang="ts">
  import SocialDistanceBadge from '@iris/svelte-ui/SocialDistanceBadge.svelte';
  import { getFollowDistance, getFollowedByFriends, socialGraphStore } from '../../utils/socialGraph';
  import { nostrStore } from '../../nostr/store';

  interface Props {
    pubKeyHex: string;
    size?: 'sm' | 'md' | 'lg';
    class?: string;
  }

  let { pubKeyHex, size = 'md', class: className = '' }: Props = $props();
  const sizes = { sm: 12, md: 16, lg: 20 };
  let distance = $derived.by(() => {
    $socialGraphStore.version;
    return getFollowDistance(pubKeyHex);
  });
  let friends = $derived.by(() => {
    $socialGraphStore.version;
    return getFollowedByFriends(pubKeyHex).size;
  });
</script>

{#if $nostrStore.pubkey && pubKeyHex}
  <SocialDistanceBadge
    {distance}
    followedByFriends={friends}
    size={sizes[size]}
    class={className}
  />
{/if}
