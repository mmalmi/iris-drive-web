<script lang="ts">
  /**
   * A photo filling the box it is in: its small copy, or a video's first
   * frame, loaded when it is about to be seen.
   */
  import type { Photo } from '../lib/photos';
  import { getNhashFileUrl } from '../lib/mediaUrl';
  import { nearView } from '../lib/nearView';
  import { photoThumbnail } from '../lib/photoThumbnails';

  interface Props {
    photo: Photo;
    /** The app's own address for files is ready to serve them. */
    ready: boolean;
  }

  let { photo, ready }: Props = $props();

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

<span class="absolute inset-0 block" use:nearView={() => (near = true)}>
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
</span>
