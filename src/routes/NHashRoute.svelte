<script lang="ts">
  import { onMount } from 'svelte';
  import FileBrowser from '../components/FileBrowser.svelte';
  import Viewer from '../components/Viewer/Viewer.svelte';
  import { nostrStore } from '../nostr';
  import { isViewingFileStore, currentHash, routeStore } from '../stores';
  import { routeDocumentFolderName } from '../lib/documentNames';
  import { nhashDecode } from '@hashtree/core';
  import { getQueryParamsFromHash } from '../lib/router.svelte';

  interface Props {
    nhash: string;
  }

  let { nhash }: Props = $props();

  let hash = $derived($currentHash);
  // A snapshot of a document opens in the editor, like a file, not as a folder listing.
  let isViewingFile = $derived($isViewingFileStore || !!routeDocumentFolderName($routeStore));
  let isValid = $state(true);

  let showViewer = $derived(isViewingFile || getQueryParamsFromHash(hash).get('fullscreen') === '1');

  onMount(() => {
    nostrStore.setSelectedTree(null);

    try {
      nhashDecode(nhash); // Validate
      isValid = true;
    } catch {
      isValid = false;
    }
  });
</script>

{#if isValid}
  <!-- An open file takes the folder's place; the list stays as it was underneath. -->
  <div class={showViewer ? 'hidden' : 'flex flex-1 flex-col min-h-0'}>
    <FileBrowser />
  </div>
  <div class={showViewer ? 'flex flex-1 flex-col min-w-0 min-h-0 bg-surface-1/30' : 'hidden'}>
    <Viewer />
  </div>
{:else}
  <div class="p-4 text-muted">This link is not valid</div>
{/if}
