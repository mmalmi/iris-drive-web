<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { DriveDocument } from '../../lib/yjs';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);

  onMount(() => {
    void drive.open();
  });

  onDestroy(() => {
    drive.destroy();
  });
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0" data-testid="document-editor">
  <DocumentHeader {drive} />
  <div class="flex-1 flex items-center justify-center text-text-3 text-sm">
    {#if drive.loading && drive.missing}
      Spreadsheet not found
    {:else if drive.loading}
      <span class="i-lucide-loader-2 animate-spin"></span>
    {/if}
  </div>
</div>
