<script lang="ts">
  /**
   * FollowedBy component - shows which friends follow a user
   */
  import { nip19 } from 'nostr-tools';
  import { Avatar, Name, Badge } from './index';
  import { getFollowDistance, getFollowedByFriends, socialGraphStore } from '../../utils/socialGraph';
  import { nostrStore } from '../../nostr';

  const MAX_AVATARS = 3;
  const MAX_NAMES = 3;

  interface Props {
    pubkey: string;
    class?: string;
  }

  let { pubkey, class: className = '' }: Props = $props();

  let myPubkey = $derived($nostrStore.pubkey);

  // Re-derive when graph version changes
  let distance = $derived.by(() => {
    $socialGraphStore.version;
    return getFollowDistance(pubkey);
  });
  let friends = $derived.by(() => {
    $socialGraphStore.version;
    return getFollowedByFriends(pubkey);
  });

  let friendsArray = $derived(Array.from(friends).slice(0, MAX_AVATARS));
  let total = $derived(friends.size);

  // Don't show for self
  let isSelf = $derived(pubkey === myPubkey);

  let namedFriends = $derived(friendsArray.slice(0, MAX_NAMES));
  let others = $derived(total - namedFriends.length);

  // "Followed by A", "A and B", "A, B and C", "A, B, C and 4 others"
  function leadIn(index: number): string {
    if (index === 0) return 'Followed by ';
    return index === namedFriends.length - 1 && others === 0 ? ' and ' : ', ';
  }

  function getNpub(pk: string): string {
    try {
      return nip19.npubEncode(pk);
    } catch {
      return pk;
    }
  }
</script>

{#if !isSelf}
  {#if total === 0}
    {#if distance === 1 || distance === 2}
      <div data-testid="profile-follow-explanation" class="flex items-center gap-2 text-sm text-text-2 {className}">
        <Badge pubKeyHex={pubkey} size="sm" />
        {distance === 1 ? 'You follow them' : 'Followed by your network'}
      </div>
    {:else if distance === 3}
      <div data-testid="profile-follow-explanation" class="text-sm text-text-2 {className}">
        Followed by friends of friends
      </div>
    {/if}
  {:else}
    <div data-testid="profile-follow-explanation" class="flex items-center gap-2 {className}">
      <Badge pubKeyHex={pubkey} size="sm" />
      <!-- Avatar stack -->
      <div class="flex -space-x-2 shrink-0">
        {#each friendsArray as pk (pk)}
          <a
            href="#/{getNpub(pk)}"
            class="rounded-full ring-2 ring-surface-0 hover:z-10 no-underline"
          >
            <Avatar pubkey={pk} size={24} />
          </a>
        {/each}
      </div>

      <!-- Names -->
      <div class="text-sm text-text-2 min-w-0 truncate">
        {#each namedFriends as pk, i (pk)}
          <span>{leadIn(i)}</span>
          <a href="#/{getNpub(pk)}" class="inline-flex items-baseline text-text-1 no-underline hover:text-accent"><Name pubkey={pk} /></a>
        {/each}
        {#if others > 0}
          <span>{` and ${others} other${others !== 1 ? 's' : ''}`}</span>
        {/if}
      </div>
    </div>
  {/if}
{/if}
