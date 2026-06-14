<script lang="ts">
  import { navigate } from '../lib/router.svelte';
  import { canUseInjectedHtreeServerUrl, getInjectedHtreeServerUrl } from '../lib/nativeHtree';

  interface Props {
    nhash: string;
    subpath?: string;
  }

  let { nhash, subpath = '' }: Props = $props();

  let error = $state<string | null>(null);

  // Use native htree server URL if available, otherwise empty (service worker handles it)
  let htreeServerUrl = $derived.by(() => {
    if (canUseInjectedHtreeServerUrl()) {
      return getInjectedHtreeServerUrl() ?? '';
    }
    return '';
  });

  // Build iframe URL: htree server serves /htree/nhash/... paths
  let iframeSrc = $derived.by(() => {
    const filePath = subpath ? `/${subpath}` : '/index.html';
    return `${htreeServerUrl}/htree/${nhash}${filePath}`;
  });

  function goBack() {
    navigate('/');
  }
</script>

<div class="flex-1 flex flex-col">
  <!-- Toolbar -->
  <div class="h-10 flex items-center gap-2 px-2 bg-base-200 b-b b-base-300">
    <button class="btn btn-ghost btn-xs" onclick={goBack}>
      &larr; Back
    </button>
    <div class="flex-1 text-sm truncate text-base-content/60">
      /{nhash}{subpath ? '/' + subpath : ''}
    </div>
    <div class="text-xs text-success">
      Offline
    </div>
  </div>

  <!-- Content -->
  {#if error}
    <div class="flex-1 flex items-center justify-center text-error">
      {error}
    </div>
  {:else if iframeSrc}
    <iframe
      src={iframeSrc}
      class="flex-1 w-full border-0"
      sandbox="allow-scripts"
      title="Saved App"
    ></iframe>
  {:else}
    <div class="flex-1 flex items-center justify-center">
      <span class="i-lucide-loader-2 animate-spin text-2xl"></span>
    </div>
  {/if}
</div>
