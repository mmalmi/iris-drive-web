<script lang="ts">
  /**
   * One photo or video over the whole screen, with the ones before and after
   * it: the arrow keys or a swipe step, Escape or Back closes.
   */
  import type { Photo } from '../lib/photos';
  import { getNhashFileUrl } from '../lib/mediaUrl';
  import { describeModified } from '../lib/modifiedAt';
  import { downloadFile } from '../lib/downloadEntry';
  import { toast } from '../stores/toast';
  import MediaPlayer from './Viewer/MediaPlayer.svelte';

  interface Props {
    photos: Photo[];
    index: number;
    /** When it was taken, as far as is known. */
    dateOf: (photo: Photo) => number | null;
    onstep: (index: number) => void;
    onclose: () => void;
  }

  let { photos, index, dateOf, onstep, onclose }: Props = $props();

  let photo = $derived(photos[index]!);
  let date = $derived(dateOf(photo));
  let hasPrevious = $derived(index > 0);
  let hasNext = $derived(index < photos.length - 1);
  let loaded = $state(false);
  let failed = $state(false);
  let dialog: HTMLDivElement | undefined = $state();
  let touchStart: { x: number; y: number } | null = null;

  const urlOf = (item: Photo) => getNhashFileUrl(item.cid, item.name);

  $effect(() => {
    void photo.href;
    loaded = false;
    failed = false;
  });

  $effect(() => {
    dialog?.focus();
  });

  // The pictures on either side are fetched ahead, so stepping shows them at once.
  $effect(() => {
    for (const near of [photos[index - 1], photos[index + 1]]) {
      if (near && !near.video) new Image().src = urlOf(near);
    }
  });

  function step(by: number) {
    const next = index + by;
    if (next >= 0 && next < photos.length) onstep(next);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    // A playing video's own keys move within it.
    const inMedia = target?.closest('video, audio, input');
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
    } else if (event.key === 'ArrowLeft' && !inMedia) {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight' && !inMedia) {
      event.preventDefault();
      step(1);
    }
  }

  function ontouchstart(event: TouchEvent) {
    const touch = event.touches[0];
    touchStart = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function ontouchend(event: TouchEvent) {
    const touch = event.changedTouches[0];
    if (!touchStart || !touch) return;
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }

  function download() {
    downloadFile(photo).catch(() => toast.error(`Could not download ${photo.name}`));
  }
</script>

<svelte:window {onkeydown} />

<div
  bind:this={dialog}
  class="fixed inset-0 z-50 flex flex-col bg-black text-white outline-none"
  role="dialog"
  aria-modal="true"
  aria-label={photo.name}
  tabindex="-1"
  data-testid="photo-viewer"
>
  <div class="flex shrink-0 items-center gap-1 px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-2 sm:px-3">
    <button type="button" class="btn-circle h-10 w-10 text-white hover:bg-white/15" onclick={onclose} title="Close" aria-label="Close" data-testid="photo-viewer-close">
      <span class="i-lucide-x text-xl"></span>
    </button>
    <div class="min-w-0 flex-1 px-1">
      <div class="truncate text-sm font-medium" data-testid="photo-viewer-name">{photo.name}</div>
      <div class="truncate text-xs text-white/60">
        {date !== null ? describeModified(date) : photo.where}
      </div>
    </div>
    <a
      href={photo.href}
      class="flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-sm text-white no-underline hover:bg-white/15 max-sm:w-10 max-sm:justify-center max-sm:px-0"
      title="Open in folder"
      aria-label="Open in folder"
      data-testid="photo-viewer-open-in-folder"
    >
      <span class="i-lucide-folder-open text-lg"></span><span class="max-sm:hidden">Open in folder</span>
    </a>
    <button
      type="button"
      class="flex h-10 shrink-0 items-center gap-2 rounded-full px-3 text-sm text-white hover:bg-white/15 max-sm:w-10 max-sm:justify-center max-sm:px-0"
      onclick={download}
      title="Download"
      aria-label="Download"
      data-testid="photo-viewer-download"
    >
      <span class="i-lucide-download text-lg"></span><span class="max-sm:hidden">Download</span>
    </button>
  </div>

  <!-- A swipe does what the arrow keys and the buttons do. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="relative mb-[env(safe-area-inset-bottom)] min-h-0 flex-1" {ontouchstart} {ontouchend}>
    {#key photo.href}
      {#if photo.video}
        <div class="absolute inset-0 flex flex-col">
          <MediaPlayer cid={photo.cid} fileName={photo.name} type="video" />
        </div>
      {:else if failed}
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-white/70">
          <span class="i-lucide-image-off text-4xl"></span>
          This picture can't be shown here.
          <button type="button" class="btn-primary" onclick={download}>Download</button>
        </div>
      {:else}
        {#if !loaded}
          <span class="i-lucide-loader-2 absolute left-1/2 top-1/2 -ml-3 -mt-3 animate-spin text-2xl text-white/60"></span>
        {/if}
        <img
          src={urlOf(photo)}
          alt={photo.name}
          class="absolute inset-0 h-full w-full select-none object-contain"
          draggable="false"
          onload={() => (loaded = true)}
          onerror={() => (failed = true)}
          data-testid="photo-viewer-image"
        />
      {/if}
    {/key}

    {#if hasPrevious}
      <button
        type="button"
        class="absolute left-2 top-1/2 z-30 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/70 sm:flex"
        onclick={() => step(-1)}
        title="Previous"
        aria-label="Previous"
        data-testid="photo-viewer-previous"
      >
        <span class="i-lucide-chevron-left text-2xl"></span>
      </button>
    {/if}
    {#if hasNext}
      <button
        type="button"
        class="absolute right-2 top-1/2 z-30 hidden h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/70 sm:flex"
        onclick={() => step(1)}
        title="Next"
        aria-label="Next"
        data-testid="photo-viewer-next"
      >
        <span class="i-lucide-chevron-right text-2xl"></span>
      </button>
    {/if}
  </div>
</div>
