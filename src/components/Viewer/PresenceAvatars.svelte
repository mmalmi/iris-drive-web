<script lang="ts">
  /**
   * The others who have the document open: a round initial in each one's
   * colour, with the follow checkmark when the follow graph this device holds
   * has one. Pointing at one names them at once. A click, Enter or Space
   * lists everyone here, each with a way to go to where they are and, when
   * known, to their page; on a phone the count opens the list from the
   * bottom of the screen. Escape closes it and gives the keyboard back.
   */
  import { tick } from 'svelte';
  import type { LivePresence, PresenceUser } from '../../lib/yjs/presence.svelte';
  import { npubPersonHref } from '../../drive/people';
  import FollowBadge from '../User/FollowBadge.svelte';

  interface Props {
    presence: LivePresence;
  }
  let { presence }: Props = $props();

  type Peer = PresenceUser & { clientId: number };

  const SHOWN = 4;

  let peers = $derived(presence.peers);
  let names = $derived(peers.map(nameOf).join(', '));
  /** Whose name shows beside them, by person. */
  let pointed = $state<string | null>(null);
  let open = $state.raw<{ opener: HTMLElement; sheet: boolean } | null>(null);
  let root: HTMLElement | undefined = $state();
  let panel: HTMLElement | undefined = $state();

  function nameOf(peer: PresenceUser): string {
    return peer.name.trim() || 'Someone';
  }

  function initial(peer: PresenceUser): string {
    return (Array.from(nameOf(peer))[0] ?? '?').toUpperCase();
  }

  function toggle(event: MouseEvent): void {
    const opener = event.currentTarget as HTMLElement;
    if (open?.opener === opener) {
      close(true);
      return;
    }
    pointed = null;
    open = { opener, sheet: window.matchMedia('(max-width: 639px)').matches };
    void tick().then(() => panel?.querySelector<HTMLElement>('button:not(:disabled), a')?.focus());
  }

  function close(returnFocus: boolean): void {
    const opener = open?.opener;
    open = null;
    if (returnFocus) opener?.focus();
  }

  function goTo(peer: Peer): void {
    const state = presence.stateOf(peer.clientId);
    const finder = presence.finder;
    close(true);
    if (state && finder?.can(state)) finder.go(state);
  }

  // Escape, or a press anywhere else, closes the list; so does everyone leaving.
  $effect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (panel?.contains(event.target) || root?.contains(event.target))) return;
      close(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  });

  $effect(() => {
    if (peers.length === 0 && open) close(false);
  });
</script>

{#if peers.length > 0}
  <div bind:this={root} class="presence" role="group" aria-label="Also here: {names}" data-testid="presence">
    <span class="avatars">
      {#each peers.slice(0, SHOWN) as peer (peer.id)}
        <span class="slot">
          <button
            type="button"
            class="avatar"
            style:background-color={peer.color}
            aria-label={nameOf(peer)}
            aria-haspopup="dialog"
            aria-expanded={!!open}
            aria-describedby={pointed === peer.id ? `presence-tip-${peer.clientId}` : undefined}
            data-testid="presence-avatar"
            data-name={nameOf(peer)}
            onclick={toggle}
            onpointerenter={() => { if (!open) pointed = peer.id; }}
            onpointerleave={() => { if (pointed === peer.id) pointed = null; }}
            onfocus={(event) => { if (!open && (event.currentTarget as HTMLElement).matches(':focus-visible')) pointed = peer.id; }}
            onblur={() => { if (pointed === peer.id) pointed = null; }}
          >
            {initial(peer)}
            {#if peer.npub}<span class="badge"><FollowBadge pubkey={peer.npub} size={11} /></span>{/if}
          </button>
          {#if pointed === peer.id}
            <span class="tip" role="tooltip" id="presence-tip-{peer.clientId}" data-testid="presence-tooltip">
              {nameOf(peer)}{#if peer.npub}<FollowBadge pubkey={peer.npub} size={13} />{/if}
            </span>
          {/if}
        </span>
      {/each}
      {#if peers.length > SHOWN}
        <button
          type="button"
          class="avatar more"
          aria-label="{peers.length - SHOWN} more: {peers.slice(SHOWN).map(nameOf).join(', ')}"
          aria-haspopup="dialog"
          aria-expanded={!!open}
          data-testid="presence-more"
          onclick={toggle}
        >+{peers.length - SHOWN}</button>
      {/if}
    </span>
    <button
      type="button"
      class="count"
      aria-label="Also here: {names}"
      aria-haspopup="dialog"
      aria-expanded={!!open}
      data-testid="presence-count"
      onclick={toggle}
    >
      <span class="dot" style:background-color={peers[0]!.color}>{initial(peers[0]!)}</span>{peers.length}
    </button>

    {#if open}
      {#if open.sheet}
        <!-- A tap beside the list only closes it. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="backdrop" onclick={() => close(false)}></div>
      {/if}
      <div
        bind:this={panel}
        class="people"
        class:sheet={open.sheet}
        role="dialog"
        aria-label="Also here"
        data-testid="presence-people"
        data-sheet={open.sheet ? 'true' : undefined}
      >
        <div class="heading">Also here</div>
        <ul>
          {#each peers as peer (peer.id)}
            {@const state = presence.stateOf(peer.clientId)}
            {@const reachable = !!state && !!presence.finder?.can(state)}
            <li class="person" data-testid="presence-person" data-name={nameOf(peer)}>
              <span class="avatar small" style:background-color={peer.color} aria-hidden="true">{initial(peer)}</span>
              <span class="who">
                {#if peer.npub}
                  <a class="name" href={npubPersonHref(peer.npub)} title="Open {nameOf(peer)}'s page" data-testid="presence-person-link" onclick={() => close(false)}>{nameOf(peer)}</a>
                  <FollowBadge pubkey={peer.npub} size={14} />
                {:else}
                  <span class="name">{nameOf(peer)}</span>
                {/if}
              </span>
              <button
                type="button"
                class="go"
                disabled={!reachable}
                aria-label="Go to {nameOf(peer)}"
                title={reachable ? `Go to where ${nameOf(peer)} is` : `${nameOf(peer)} is not in it just now`}
                data-testid="presence-go"
                onclick={() => goTo(peer)}
              >Go to</button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}

<style>
  .presence {
    position: relative;
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .avatars {
    display: flex;
    align-items: center;
  }

  .slot {
    position: relative;
    display: inline-flex;
  }

  .slot + .slot,
  .slot + .more {
    margin-left: -6px;
  }

  .avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 9999px;
    border: 2px solid rgb(var(--surface-1));
    color: #fff;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    user-select: none;
  }

  .avatar:hover,
  .avatar:focus-visible {
    z-index: 1;
    outline: 2px solid #916dfe;
    outline-offset: 1px;
  }

  .avatar.small {
    width: 28px;
    height: 28px;
    border: 0;
    cursor: default;
    flex-shrink: 0;
  }

  .badge {
    position: absolute;
    right: -4px;
    bottom: -4px;
    display: flex;
  }

  .avatar.more {
    background: rgb(var(--surface-3));
    color: rgb(var(--text-1));
    font-size: 0.65rem;
  }

  /* Named as soon as it is pointed at. */
  .tip {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    z-index: 60;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgb(var(--text-1));
    color: rgb(var(--surface-1));
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
  }

  .count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 8px 0 3px;
    border: 0;
    border-radius: 9999px;
    background: rgb(var(--surface-2));
    color: rgb(var(--text-2));
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
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

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 59;
    background: rgb(0 0 0 / 0.4);
  }

  .people {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 60;
    width: 280px;
    max-height: 60vh;
    overflow-y: auto;
    padding: 6px 0;
    border-radius: 12px;
    background: rgb(var(--surface-1));
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.16);
    outline: 1px solid rgb(var(--surface-3));
  }

  .people.sheet {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    border-radius: 16px 16px 0 0;
    padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
  }

  .heading {
    padding: 4px 14px 6px;
    color: rgb(var(--text-3));
    font-size: 0.75rem;
    font-weight: 500;
  }

  .people.sheet .heading {
    padding: 6px 20px 8px;
    font-size: 0.85rem;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .person {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px 6px 14px;
  }

  .people.sheet .person {
    padding: 10px 16px 10px 20px;
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    color: rgb(var(--text-1));
    font-size: 0.875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-decoration: none;
  }

  a.name:hover,
  a.name:focus-visible {
    text-decoration: underline;
  }

  .go {
    flex-shrink: 0;
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 9999px;
    background: rgb(var(--surface-2));
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .go:hover:not(:disabled),
  .go:focus-visible {
    background: rgb(var(--surface-3));
  }

  .go:disabled {
    opacity: 0.5;
    cursor: default;
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
