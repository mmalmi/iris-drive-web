<script lang="ts">
  import { LinkType, toHex, type TreeEntry } from '@hashtree/core';
  import type { ItemAccess } from '../drive/itemAccess';
  import { isPhotoName, isVideoName } from '../lib/photos';
  import AccessBadge from './AccessBadge.svelte';
  import PhotoImage from './PhotoImage.svelte';
  import RowDetails from './RowDetails.svelte';

  interface Props {
    entry: TreeEntry;
    title: string;
    icon: string;
    isFolder: boolean;
    checked: boolean;
    access?: ItemAccess | null;
    detailsId?: string;
    grid: boolean;
    compact: boolean;
    mediaReady: boolean;
  }

  let { entry, title, icon, isFolder, checked, access, detailsId, grid, compact, mediaReady }: Props = $props();
</script>

{#if checked}
  <span class="shrink-0 w-4 h-4 inline-grid place-items-center rounded-full bg-accent text-surface-0" aria-hidden="true" data-testid="selection-mark">
    <span class="i-lucide-check text-xs"></span>
  </span>
{:else}
  <span class="shrink-0 {icon}" aria-hidden="true" data-testid="entry-icon"></span>
{/if}
<span class="min-w-0 flex-1 flex flex-col">
  <span class="min-w-0 flex items-center gap-3">
    <span class="truncate min-w-0" title={entry.name}>{title}</span>
    <!-- Marked where sharing starts; inside a shared folder the heading says it once. -->
    {#if access}
      <AccessBadge {access} class="text-text-3 text-sm" />
    {/if}
  </span>
  {#if grid}
    <span class="sr-only"><RowDetails {entry} part="line" compact id={detailsId} /></span>
  {:else}
    <RowDetails {entry} part="line" {compact} id={detailsId} />
  {/if}
</span>
{#if grid && !isFolder}
  <span class="tile-preview" aria-hidden="true">
    <span class="{icon} text-4xl text-text-3"></span>
    {#if entry.type !== LinkType.Dir && isPhotoName(entry.name) && mediaReady}
      {#key toHex(entry.cid.hash)}
        <PhotoImage photo={{ cid: entry.cid, name: entry.name, hash: toHex(entry.cid.hash), video: isVideoName(entry.name) }} ready={mediaReady} />
      {/key}
    {/if}
  </span>
{:else if !grid}
  <RowDetails {entry} part="columns" {compact} />
{/if}

<style>
  .tile-preview {
    grid-column: 1 / -1;
    position: relative;
    aspect-ratio: 1.65;
    overflow: hidden;
    border-radius: 0.375rem;
    display: grid;
    place-items: center;
    background: rgb(var(--surface-2));
    pointer-events: none;
  }
</style>
