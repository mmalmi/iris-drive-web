<script lang="ts">
  import { onMount } from 'svelte';

  const SCROLL_THRESHOLD = 25;
  let opacity = $state(0);

  interface Props {
    children?: import('svelte').Snippet;
    sticky?: boolean;
    scrollTint?: boolean;
  }

  let { children, sticky = false, scrollTint = false }: Props = $props();

  onMount(() => {
    if (!scrollTint) {
      return;
    }

    const handleScroll = () => {
      opacity = Math.min(1, window.scrollY / SCROLL_THRESHOLD);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => window.removeEventListener('scroll', handleScroll);
  });
</script>

<header
  class={`h-14 shrink-0 flex items-center px-4 md:px-6 gap-3 z-20 bg-surface-0 ${sticky ? 'sticky top-0' : ''}`}
  style:background-color={scrollTint ? `rgb(var(--surface-0) / ${opacity})` : undefined}
  style:backdrop-filter={scrollTint ? `blur(${opacity * 12}px)` : undefined}
>
  {@render children?.()}
</header>
