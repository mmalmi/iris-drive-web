<script lang="ts">
  /**
   * ReadmePanel - Bordered panel for displaying README.md content in directory views
   */
  import { LinkType, type TreeEntry } from '@hashtree/core';
  import { routeStore } from '../../stores';
  import MarkdownViewer from './MarkdownViewer.svelte';

  interface Props {
    content: string;
    entries: TreeEntry[];
    canEdit: boolean;
  }

  let { content, entries, canEdit }: Props = $props();
  let route = $derived($routeStore);

  function handleEdit() {
    const readmeEntry = entries.find(
      e => e.name.toLowerCase() === 'readme.md' && e.type !== LinkType.Dir
    );
    if (readmeEntry) {
      const parts: string[] = [];
      if (route.npub && route.treeName) {
        parts.push(route.npub, route.treeName, ...route.path, readmeEntry.name);
      }
      window.location.hash = '/' + parts.map(encodeURIComponent).join('/') + '?edit=1';
    }
  }
</script>

<div class="bg-surface-0 b-1 b-surface-3 b-solid rounded-lg overflow-hidden">
  <div class="flex items-center justify-between px-4 py-2 b-b-1 b-b-solid b-b-surface-3">
    <div class="flex items-center gap-2">
      <span class="i-lucide-book-open text-text-2"></span>
      <span class="text-sm font-medium">README.md</span>
    </div>
    {#if canEdit}
      <button
        onclick={handleEdit}
        class="btn-ghost text-xs px-2 py-1"
      >
        Edit
      </button>
    {/if}
  </div>
  <MarkdownViewer {content} dirPath={route.path} />
</div>
