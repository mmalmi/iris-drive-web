<script lang="ts">
  /** The albums: each folder that holds photos, as its newest photo, its name and how many it holds. */
  import type { ItemAccess } from '../drive/itemAccess';
  import { albumHref, countLabel, type Album } from '../lib/photos';
  import AccessBadge from './AccessBadge.svelte';
  import PhotoImage from './PhotoImage.svelte';

  interface Props {
    albums: Album[];
    ready: boolean;
    /** Who can open an album's folder; a mark shows when it is more than its owner. */
    accessOf: (album: Album) => ItemAccess | null;
  }

  let { albums, ready, accessOf }: Props = $props();
</script>

<div class="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-4 p-3 lg:gap-x-4 lg:px-5" data-testid="album-list">
  {#each albums as album (album.key)}
    {@const access = accessOf(album)}
    <a href={albumHref(album.scope, album.path)} class="group block min-w-0 no-underline outline-none" aria-label={album.name} data-testid="album-card">
      <span class="relative block aspect-square overflow-hidden rounded-xl bg-surface-2 ring-accent group-focus-visible:ring-3">
        <PhotoImage photo={album.photos[0]!} {ready} />
        <span class="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10"></span>
      </span>
      <span class="mt-2 flex min-w-0 items-center gap-1.5">
        <span class="truncate text-sm font-medium text-text-1" data-testid="album-name">{album.name}</span>
        {#if access && access.kind !== 'private'}
          <AccessBadge {access} class="text-sm text-text-3" />
        {/if}
      </span>
      <span class="block text-xs text-text-2" data-testid="album-count">{countLabel(album.photos)}</span>
    </a>
  {/each}
</div>
