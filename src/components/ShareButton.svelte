<script lang="ts">
  /**
   * Shared circular share button component
   */
  import { open as openShareModal } from './Modals/ShareModal.svelte';
  import type { SharePeopleTarget } from '../drive/sharePeople';

  interface Props {
    url: string | null;
    latestUrl?: string | null;
    /** A folder or document people can be invited to. */
    people?: SharePeopleTarget | null;
    class?: string;
  }

  let { url, latestUrl = null, people = null, class: className = '' }: Props = $props();
</script>

<button
  onclick={() => { if (url) openShareModal(url, latestUrl, people); }}
  class="btn-circle btn-ghost {className}"
  title={url ? 'Share' : 'Preparing share link…'}
  disabled={!url}
>
  <span class={url ? 'i-lucide-share text-base' : 'i-lucide-loader-2 animate-spin text-base'}></span>
</button>
