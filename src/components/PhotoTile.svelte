<script lang="ts">
  /**
   * One square in Photos. A click opens it, or chooses it while others are
   * chosen; its round box (on hover, or always while choosing) or a long
   * press on a phone chooses it.
   */
  import type { Photo } from '../lib/photos';
  import { longPress } from '../lib/longPress';
  import GridThumbnail from './GridThumbnail.svelte';

  interface Props {
    photo: Photo;
    href: string;
    ready: boolean;
    selected: boolean;
    /** Some photo is chosen: a click chooses rather than opens. */
    selecting: boolean;
    onopen: (event: MouseEvent) => void;
    ontoggle: () => void;
  }

  let { photo, href, ready, selected, selecting, onopen, ontoggle }: Props = $props();

  function click(event: MouseEvent) {
    // The click that ends a long press only lifts the finger.
    if (event.defaultPrevented) return;
    if (selecting) {
      event.preventDefault();
      ontoggle();
      return;
    }
    onopen(event);
  }
</script>

<div class="group relative aspect-square">
  <a
    {href}
    onclick={click}
    use:longPress={() => ontoggle()}
    class="absolute inset-0 block overflow-hidden no-underline outline-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-inset {selected ? 'bg-accent/15' : 'bg-surface-2'}"
    title={photo.name}
    aria-label={photo.name}
    data-photo={photo.href}
    data-testid="photo-tile"
    data-selected={selected ? '' : undefined}
  >
    <span class="absolute block overflow-hidden bg-surface-2 transition-all duration-150 {selected ? 'inset-[8%] rounded-lg' : 'inset-0'}">
      <GridThumbnail cid={photo.cid} name={photo.name} kind={photo.video ? 'video' : 'image'} {ready} fallback />
    </span>
    {#if photo.video}
      <span class="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white">
        <span class="i-lucide-play text-xs"></span>
      </span>
    {/if}
    {#if !selecting}
      <span class="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 to-transparent to-35% opacity-0 transition-opacity group-hover:opacity-100"></span>
    {/if}
  </a>
  <button
    type="button"
    role="checkbox"
    aria-checked={selected}
    aria-label="Select {photo.name}"
    title={selected ? 'Unselect' : 'Select'}
    class="absolute left-1 top-1 z-10 flex h-8 w-8 items-center justify-center rounded-full transition-opacity focus-visible:opacity-100 {selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}"
    onclick={ontoggle}
    data-testid="photo-select"
  >
    {#if selected}
      <span class="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow">
        <span class="i-lucide-check text-sm"></span>
      </span>
    {:else}
      <span class="h-5.5 w-5.5 rounded-full bg-black/20 ring-2 ring-white/90 shadow"></span>
    {/if}
  </button>
</div>
