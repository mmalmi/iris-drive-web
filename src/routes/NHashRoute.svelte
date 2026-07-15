<script lang="ts">
  import { onMount } from 'svelte';
  import FileBrowser from '../components/FileBrowser.svelte';
  import Viewer from '../components/Viewer/Viewer.svelte';
  import { nostrStore } from '../nostr';
  import { isViewingFileStore, currentHash } from '../stores';
  import { nhashDecode } from '@hashtree/core';
  import { getQueryParamsFromHash } from '../lib/router.svelte';
  import { shouldShowNhashFileBrowser } from '../lib/nhashRouteLayout';

  interface Props {
    nhash: string;
  }

  let { nhash }: Props = $props();

  let hash = $derived($currentHash);
  let isViewingFile = $derived($isViewingFileStore);
  let isValid = $state(true);

  let showViewer = $derived(isViewingFile);

  // Check if fullscreen mode from URL
  let isFullscreen = $derived.by(() => {
    return getQueryParamsFromHash(hash).get('fullscreen') === '1';
  });
  let showFileBrowser = $derived(shouldShowNhashFileBrowser({
    isFullscreen,
    isViewingFile,
  }));

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
  <!-- Direct root files have no parent directory to browse. -->
  {#if showFileBrowser}
    <div class="flex flex-1 shrink-0 flex-col min-h-0">
      <FileBrowser />
    </div>
  {/if}
  <!-- Viewer - shown in single-column when viewing a file -->
  <div class={showViewer || isFullscreen
    ? 'flex flex-1 flex-col min-w-0 min-h-0 bg-surface-1/30'
    : 'hidden'}>
    <Viewer />
  </div>
{:else}
  <div class="p-4 text-muted">Invalid nhash format</div>
{/if}
