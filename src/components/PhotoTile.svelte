<script lang="ts">
  /** One square in Photos: a small copy of the picture, or a video's first frame, loaded when it is about to be seen. */
  import type { Photo } from '../lib/photos';
  import { getNhashFileUrl } from '../lib/mediaUrl';
  import { nearView } from '../lib/nearView';
  import { photoThumbnail } from '../lib/photoThumbnails';

  interface Props {
    photo: Photo;
    href: string;
    /** The app's own address for files is ready to serve them. */
    ready: boolean;
    onopen: (event: MouseEvent) => void;
  }

  let { photo, href, ready, onopen }: Props = $props();

  let near = $state(false);
  let loaded = $state(false);
  let failed = $state(false);
  let url = $derived(getNhashFileUrl(photo.cid, photo.name));
  let thumbnail = $state<string | null>(null);

  $effect(() => {
    if (!near || !ready || photo.video) return;
    let current = true;
    void photoThumbnail(photo).then((src) => { if (current) thumbnail = src; });
    return () => { current = false; };
  });
</script>

<a
  {href}
  onclick={onopen}
  use:nearView={() => (near = true)}
  class="group relative block aspect-square overflow-hidden bg-surface-2 no-underline outline-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:ring-inset"
  title={photo.name}
  aria-label={photo.name}
  data-photo={photo.href}
  data-testid="photo-tile"
>
  {#if near && ready && !failed}
    {#if photo.video}
      <video
        src={`${url}#t=0.1`}
        preload="metadata"
        muted
        playsinline
        class="h-full w-full object-cover pointer-events-none transition-opacity duration-200 {loaded ? 'opacity-100' : 'opacity-0'}"
        onloadeddata={() => (loaded = true)}
        onerror={() => (failed = true)}
      ></video>
    {:else if thumbnail}
      <img
        src={thumbnail}
        alt=""
        decoding="async"
        draggable="false"
        class="h-full w-full object-cover transition-opacity duration-200 {loaded ? 'opacity-100' : 'opacity-0'}"
        onload={() => (loaded = true)}
        onerror={() => (failed = true)}
      />
    {/if}
  {/if}
  {#if failed}
    <span class="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-xs text-text-3">
      <span class="{photo.video ? 'i-lucide-video' : 'i-lucide-image'} text-2xl"></span>
      <span class="w-full truncate">{photo.name}</span>
    </span>
  {/if}
  {#if photo.video}
    <span class="pointer-events-none absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white">
      <span class="i-lucide-play text-xs"></span>
    </span>
  {/if}
  <span class="pointer-events-none absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10"></span>
</a>
