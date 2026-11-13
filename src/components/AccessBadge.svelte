<script lang="ts">
  /**
   * Shows who can open an item: private, shared with people, anyone with the
   * link, or public. With `onclick` it is a button that opens sharing.
   */
  import { describeItemAccess, type ItemAccess } from '../drive/itemAccess';

  interface Props {
    access: ItemAccess | null;
    /** Show the words beside the icon; they hide on narrow screens. */
    label?: boolean;
    onclick?: () => void;
    class?: string;
  }

  let { access, label = false, onclick, class: className = '' }: Props = $props();

  let info = $derived(access ? describeItemAccess(access) : null);
  const chip = 'shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs bg-surface-2 text-text-2';
</script>

{#if access && info}
  {#if label}
    {#snippet content()}
      <span class="{info.icon} text-sm"></span>
      <span class="max-sm:hidden whitespace-nowrap">{info.label}</span>
    {/snippet}
    {#if onclick}
      <button
        type="button"
        {onclick}
        class="{chip} b-0 cursor-pointer hover:text-text-1 hover:bg-surface-3 {className}"
        title={info.detail}
        aria-label={info.detail}
        data-testid="access-badge"
        data-access={access.kind}
      >
        {@render content()}
      </button>
    {:else}
      <span class="{chip} {className}" title={info.detail} data-testid="access-badge" data-access={access.kind}>
        {@render content()}
      </span>
    {/if}
  {:else}
    <span
      class="shrink-0 {info.icon} {className}"
      title={info.detail}
      role="img"
      aria-label={info.detail}
      data-testid="access-icon"
      data-access={access.kind}
    ></span>
  {/if}
{/if}
