<script lang="ts">
  /**
   * MediaPlayer - Streaming media player for video and audio
   *
   * Uses Service Worker streaming:
   * - /{npub}/{treeName}/{path} URLs intercepted by service worker
   * - Service worker requests data from main thread via MessageChannel
   * - Main thread streams data from hashtree
   * - Browser handles seeking, buffering, range requests natively
   *
   * No MSE needed - the browser handles everything!
   */
  import type { CID } from '@hashtree/core';
  import { getCidFileUrl, getNpubFileUrlAsync, isNpubTreeScope } from '../../lib/mediaUrl';
  import { ensureMediaStreamingReady } from '../../lib/mediaStreamingSetup';

  interface Props {
    cid: CID;
    fileName: string;
    fileSize?: number;
    /** Media type: 'video' or 'audio' */
    type?: 'video' | 'audio';
    /** Where the file is in a tree, so the newest version plays (optional) */
    npub?: string;
    treeName?: string;
    path?: string;
  }

  let props: Props = $props();
  let cid = $derived(props.cid);
  let fileName = $derived(props.fileName);
  let mediaType = $derived(props.type ?? 'video');
  let isAudio = $derived(mediaType === 'audio');
  let npub = $derived(props.npub);
  let treeName = $derived(props.treeName);
  let filePath = $derived(props.path);

  let mediaRef: HTMLVideoElement | HTMLAudioElement | undefined = $state();
  let loading = $state(true);
  let error = $state<string | null>(null);
  let duration = $state(0);
  let currentTime = $state(0);
  let paused = $state(true);
  let hasBeenReady = $state(false);

  function markReady() {
    if (hasBeenReady) return;
    hasBeenReady = true;
    loading = false;
  }

  // Load media using service worker streaming
  async function loadMedia() {
    if (!cid?.hash || !mediaRef) {
      error = 'No file CID or media element';
      loading = false;
      return;
    }

    const streamingReady = await ensureMediaStreamingReady().catch((err) => {
      console.warn('[MediaPlayer] Media streaming setup failed:', err);
      return false;
    });
    if (!streamingReady) {
      error = 'Media streaming unavailable';
      loading = false;
      return;
    }

    // Use the tree path when it can be served, so the newest version plays; otherwise the CID
    let url: string;
    if (isNpubTreeScope(npub) && treeName && filePath) {
      // Use async version to ensure Tauri htree server URL is available
      url = await getNpubFileUrlAsync(npub, treeName, filePath);
    } else {
      url = getCidFileUrl(cid, fileName);
    }

    // Add cache-busting timestamp so the browser always fetches fresh content
    const cacheSeparator = url.includes('?') ? '&' : '?';
    mediaRef.src = `${url}${cacheSeparator}_t=${Date.now()}`;

    // Listen for metadata to get duration
    mediaRef.addEventListener('loadedmetadata', () => {
      if (mediaRef && !isNaN(mediaRef.duration) && isFinite(mediaRef.duration)) {
        duration = mediaRef.duration;
        // Don't seek on initial load - let the video play from the start
        // Seeking to near-end is only done on tree updates when we want to catch up
      }
    }, { once: true });

    mediaRef.addEventListener('loadeddata', () => {
      markReady();
    }, { once: true });

    mediaRef.addEventListener('canplay', () => {
      markReady();
    }, { once: true });

    mediaRef.addEventListener('playing', () => {
      markReady();
    }, { once: true });

    mediaRef.addEventListener('error', (e) => {
      console.error('[MediaPlayer] Error:', e);
      // Get more specific error message from MediaError
      const mediaError = mediaRef?.error;
      if (mediaError) {
        switch (mediaError.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            error = 'Playback aborted';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            error = 'Network error while loading media';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            error = 'Unable to play: codec not supported by your browser';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            error = 'Media format not supported by your browser';
            break;
          default:
            error = mediaError.message || 'Failed to load media';
        }
      } else {
        error = 'Failed to load media';
      }
      loading = false;
    }, { once: true });

    // Try to start playback
    try {
      await mediaRef.play();
    } catch {
      // Autoplay was blocked; the controls start it.
    }
  }

  function handleTimeUpdate() {
    if (mediaRef) {
      if (!hasBeenReady && mediaRef.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        markReady();
      }
      currentTime = mediaRef.currentTime;
    }
  }

  function handleDurationChange() {
    if (mediaRef && !isNaN(mediaRef.duration) && isFinite(mediaRef.duration)) {
      duration = mediaRef.duration;
      if (!hasBeenReady && mediaRef.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        markReady();
      }
    }
  }

  function handlePlay() {
    paused = false;
  }

  function handlePause() {
    paused = true;
  }

  function togglePlay() {
    if (!mediaRef) return;
    if (mediaRef.paused) {
      mediaRef.play();
    } else {
      mediaRef.pause();
    }
  }

  function formatTime(seconds: number): string {
    if (!isFinite(seconds)) return '--:--';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  // Load when mounted
  let hasStartedLoading = false;
  $effect(() => {
    if (mediaRef && !hasStartedLoading) {
      hasStartedLoading = true;
      loadMedia().catch((e) => {
        console.error('Failed to load media:', e);
        error = e instanceof Error ? e.message : 'Failed to load media';
        loading = false;
      });
    }
  });
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-hidden" class:bg-black={!isAudio} class:bg-surface-0={isAudio}>
  <div class="relative flex-1 flex flex-col items-center justify-center min-h-0" class:p-4={isAudio}>
    <!-- Loading overlay -->
    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center text-white z-20" class:bg-black={!isAudio} class:bg-surface-0={isAudio} class:text-text-1={isAudio}>
        <div class="flex flex-col items-center gap-2">
          <span class="i-lucide-loader-2 animate-spin text-2xl"></span>
          <span>Loading {isAudio ? 'audio' : 'video'}...</span>
        </div>
      </div>
    {/if}

    <!-- Error overlay -->
    {#if error}
      <div class="absolute inset-0 flex items-center justify-center text-red-400 z-20" class:bg-black={!isAudio} class:bg-surface-0={isAudio}>
        <span class="i-lucide-alert-circle mr-2"></span>
        {error}
      </div>
    {/if}

    {#if isAudio}
      <!-- Audio visual placeholder -->
      <div class="w-full max-w-md flex flex-col items-center gap-4">
        <div class="w-48 h-48 rounded-lg bg-surface-2 flex items-center justify-center shadow-lg">
          <span class="i-lucide-music text-6xl text-text-2"></span>
        </div>
        <audio
          bind:this={mediaRef}
          controls
          autoplay
          class="w-full"
          class:invisible={!hasBeenReady && (loading || !!error)}
          preload="metadata"
          ontimeupdate={handleTimeUpdate}
          ondurationchange={handleDurationChange}
          onplay={handlePlay}
          onpause={handlePause}
        >
          Your browser does not support the audio tag.
        </audio>
      </div>
    {:else}
      <!-- Video element -->
      <video
        bind:this={mediaRef}
        controls
        autoplay
        playsinline
        class="max-w-full max-h-full object-contain"
        class:invisible={!hasBeenReady && (loading || !!error)}
        preload="metadata"
        ontimeupdate={handleTimeUpdate}
        ondurationchange={handleDurationChange}
        onplay={handlePlay}
        onpause={handlePause}
      >
        Your browser does not support the video tag.
      </video>

      <!-- Big play button overlay when paused (video only) -->
      {#if paused && !loading && !error}
        <button
          type="button"
          class="absolute inset-0 flex items-center justify-center z-10 cursor-pointer bg-transparent"
          onclick={togglePlay}
          aria-label="Play video"
        >
          <div class="w-20 h-20 rounded-full bg-white/90 flex items-center justify-center shadow-lg hover:bg-white hover:scale-110 transition-all">
            <span class="i-lucide-play w-10 h-10 text-black ml-1"></span>
          </div>
        </button>
      {/if}

      <!-- Duration/time info (video only) -->
      {#if !loading && !error}
        <div class="absolute bottom-16 right-3 z-10 px-2 py-1 bg-black/70 text-white text-sm rounded">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>
      {/if}
    {/if}
  </div>
</div>
