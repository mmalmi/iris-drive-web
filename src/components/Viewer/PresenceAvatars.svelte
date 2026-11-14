<script lang="ts">
  /**
   * The others who have the document open: a round initial in each one's
   * colour, named on hover, with the follow checkmark when the follow graph
   * this device holds has one. On a phone, how many they are.
   */
  import type { PresenceUser } from '../../lib/yjs/presence.svelte';
  import FollowBadge from '../User/FollowBadge.svelte';

  interface Props {
    peers: PresenceUser[];
  }
  let { peers }: Props = $props();

  const SHOWN = 4;

  function nameOf(peer: PresenceUser): string {
    return peer.name.trim() || 'Someone';
  }

  function initial(peer: PresenceUser): string {
    return (Array.from(nameOf(peer))[0] ?? '?').toUpperCase();
  }

  let names = $derived(peers.map(nameOf).join(', '));
</script>

{#if peers.length > 0}
  <div class="shrink-0 flex items-center" role="group" aria-label="Also here: {names}" title="Also here: {names}" data-testid="presence">
    <span class="avatars">
      {#each peers.slice(0, SHOWN) as peer (peer.id)}
        <span class="avatar" style:background-color={peer.color} title={nameOf(peer)} data-testid="presence-avatar" data-name={nameOf(peer)}>
          {initial(peer)}
          {#if peer.npub}<span class="badge"><FollowBadge pubkey={peer.npub} size={11} /></span>{/if}
        </span>
      {/each}
      {#if peers.length > SHOWN}
        <span class="avatar more">+{peers.length - SHOWN}</span>
      {/if}
    </span>
    <span class="count" data-testid="presence-count">
      <span class="dot" style:background-color={peers[0]!.color}>{initial(peers[0]!)}</span>{peers.length}
    </span>
  </div>
{/if}

<style>
  .avatars {
    display: flex;
    align-items: center;
  }

  .avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 9999px;
    border: 2px solid rgb(var(--surface-1));
    color: #fff;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    user-select: none;
  }

  .badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: flex;
  }

  .avatar + .avatar {
    margin-left: -6px;
  }

  .avatar.more {
    background: rgb(var(--surface-3));
    color: rgb(var(--text-1));
    font-size: 0.65rem;
  }

  .count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px 0 3px;
    border-radius: 9999px;
    background: rgb(var(--surface-2));
    color: rgb(var(--text-2));
    font-size: 0.75rem;
  }

  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    color: #fff;
    font-size: 0.6rem;
    font-weight: 600;
  }

  /* On a phone the header has no room for faces: the first, and how many. */
  @media (min-width: 640px) {
    .count {
      display: none;
    }
  }

  @media (max-width: 639px) {
    .avatars {
      display: none;
    }
  }
</style>
