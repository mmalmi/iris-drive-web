<script lang="ts">
  import NHashRoute from './NHashRoute.svelte';
  import NPathRoute from './NPathRoute.svelte';
  import { nostrStore } from '../nostr';
  import { isNHash, isNPath } from '@hashtree/core';

  interface Props {
    id?: string;
    wild?: string;
  }

  let { id }: Props = $props();

  // A person's page is not inside any folder.
  $effect(() => {
    if (id && !isNHash(id) && !isNPath(id)) {
      nostrStore.setSelectedTree(null);
    }
  });
</script>

{#if id && isNHash(id)}
  <NHashRoute nhash={id} />
{:else if id && isNPath(id)}
  <NPathRoute npath={id} />
{:else}
  {#await import('../components/PersonPage.svelte') then { default: PersonPage }}
    <PersonPage id={id || ''} />
  {/await}
{/if}
