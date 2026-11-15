<script lang="ts">
  import type { CID } from '@hashtree/core';
  import { nearView } from '../lib/nearView';
  import { requestThumbnail, type ThumbnailKind } from '../lib/gridThumbnails';

  let { cid, name, kind, ready, fallback = false }: {
    cid: CID; name: string; kind: ThumbnailKind; ready: boolean; fallback?: boolean;
  } = $props();

  let near = $state(false);
  let thumbnail = $state('');
  let failed = $state(false);

  $effect(() => {
    thumbnail = '';
    failed = false;
    if (!near || !ready) return;
    const request = requestThumbnail(cid, name, kind);
    let current = true;
    let url = '';
    void request.blob.then(blob => {
      if (current) thumbnail = url = URL.createObjectURL(blob);
    }, () => { if (current) failed = true; });
    return () => {
      current = false;
      request.release();
      if (url) URL.revokeObjectURL(url);
    };
  });
</script>

<span class="absolute inset-0 block" use:nearView={(value) => (near = value)}>
  {#if near && ready && thumbnail && !failed}
    <img src={thumbnail} alt="" decoding="async" draggable="false"
      class="h-full w-full object-cover" onerror={() => (failed = true)} />
  {:else if failed && fallback}
    <span class="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-xs text-text-3">
      <span class="{kind === 'video' ? 'i-lucide-video' : 'i-lucide-image'} text-2xl"></span>
      <span class="w-full truncate">{name}</span>
    </span>
  {/if}
</span>
