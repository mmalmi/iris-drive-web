<script lang="ts">
  import SharedMinidenticon from '@iris/svelte-ui/Minidenticon.svelte';

  interface Props {
    seed: string;
    size?: number;
    saturation?: number;
    lightness?: number;
    class?: string;
  }

  let { seed, size = 40, saturation = 50, lightness = 50, class: className = '' }: Props = $props();
</script>

<SharedMinidenticon
  {seed}
  {size}
  {saturation}
  {lightness}
  class={`rounded-full flex items-center justify-center shrink-0 bg-surface-3 ${className}`.trim()}
/>
