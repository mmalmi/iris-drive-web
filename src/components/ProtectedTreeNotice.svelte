<script lang="ts">
  import type { TreeVisibility } from '@hashtree/core';

  interface Props {
    visibility?: TreeVisibility;
    linkKey: string | null;
  }

  let { visibility, linkKey }: Props = $props();
</script>

<div class="p-8 text-center" data-testid="protected-tree-notice">
  <div class="inline-flex items-center justify-center mb-4">
    {#if visibility === 'link-visible'}
      {#if linkKey}
        <span class="i-lucide-key-round text-3xl text-danger"></span>
      {:else}
        <span class="relative inline-block shrink-0 text-3xl text-text-3">
          <span class="i-lucide-link"></span>
          <span class="i-lucide-lock absolute -bottom-0.5 -right-1.5 text-[0.6em]"></span>
        </span>
      {/if}
    {:else}
      <span class="i-lucide-lock text-3xl text-text-3"></span>
    {/if}
  </div>
  <div class="text-text-2 font-medium mb-2">
    {#if visibility === 'link-visible'}
      {linkKey ? 'This link no longer works' : 'You need the link'}
    {:else}
      Private
    {/if}
  </div>
  <div class="text-text-3 text-sm max-w-xs mx-auto">
    {#if visibility === 'link-visible'}
      {linkKey
        ? 'The owner turned it off or changed it. Ask them for a new link.'
        : 'Open it with the whole link the owner sent you.'}
    {:else}
      Only its owner can open it.
    {/if}
  </div>
</div>
