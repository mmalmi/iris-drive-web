<script lang="ts">
  /** Photos in squares under their date headings, for the timeline and for an album. */
  import type { Photo, PhotoGroup } from '../lib/photos';
  import PhotoTile from './PhotoTile.svelte';

  interface Props {
    groups: PhotoGroup[];
    ready: boolean;
    /** The chosen photos, by where they open. */
    selected: ReadonlySet<string>;
    openHref: (photo: Photo) => string;
    onopen: (event: MouseEvent) => void;
    ontoggle: (photo: Photo) => void;
  }

  let { groups, ready, selected, openHref, onopen, ontoggle }: Props = $props();
</script>

{#each groups as group (group.key)}
  <section class="pb-3" data-testid="photos-group">
    <h2 class="sticky top-0 z-20 bg-surface-0/95 px-3 py-2 text-sm font-medium text-text-1 backdrop-blur-sm lg:px-5">{group.label}</h2>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-0.5 px-0.5 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:gap-1 sm:px-3 lg:px-5">
      {#each group.photos as photo (photo.href)}
        <PhotoTile
          {photo}
          {ready}
          href={openHref(photo)}
          selected={selected.has(photo.href)}
          selecting={selected.size > 0}
          {onopen}
          ontoggle={() => ontoggle(photo)}
        />
      {/each}
    </div>
  </section>
{/each}
