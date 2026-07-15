<script lang="ts">
  import { onMount } from 'svelte';
  import DriveSetup from '../components/DriveSetup.svelte';
  import { nostrStore } from '../nostr';
  import { navigate } from '../lib/router.svelte';
  import { activeDriveRootPath } from '../drive/profileRoute';

  let homePath = $derived(activeDriveRootPath($nostrStore));

  $effect(() => {
    if (homePath !== '/') {
      navigate(homePath);
    }
  });

  onMount(() => {
    // Clear selected tree when on home route
    nostrStore.setSelectedTree(null);
  });
</script>

{#if homePath === '/'}
  <DriveSetup />
{/if}
