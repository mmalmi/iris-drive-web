<script lang="ts">
  /**
   * Shared circular share button component
   */
  import { open as openShareModal } from './Modals/ShareModal.svelte';

  interface Props {
    url: string | null;
    latestUrl?: string | null;
    class?: string;
  }

  let { url, latestUrl = null, class: className = '' }: Props = $props();
</script>

<button
  onclick={() => { if (url) openShareModal(url, latestUrl); }}
  class="btn-circle btn-ghost {className}"
  title={url ? 'Share' : 'Preparing share link…'}
  disabled={!url}
>
  <span class={url ? 'i-lucide-share text-base' : 'i-lucide-loader-2 animate-spin text-base'}></span>
</button>
