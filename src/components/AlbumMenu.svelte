<script lang="ts">
  import Menu from './ui/Menu.svelte';
  let { name, onrename, ondelete }: { name: string; onrename: () => void; ondelete: () => void } = $props();
  let at = $state<{ x: number; y: number } | null>(null);
  let sheet = $state(false);
  let button: HTMLButtonElement | undefined = $state();

  function toggle(event: MouseEvent) {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    sheet = window.matchMedia('(max-width: 639px)').matches;
    at = at ? null : { x: bounds.left, y: bounds.bottom };
  }
</script>

<span class="relative inline-flex shrink-0">
  <button type="button" bind:this={button} class="btn-circle h-8 w-8 text-text-2 hover:bg-surface-2"
    aria-label={`Options for ${name}`} title="Album options" aria-haspopup="menu" aria-expanded={!!at}
    onclick={toggle}>
    <span class="i-lucide-ellipsis text-lg"></span>
  </button>
  {#if at}
    <Menu label="Album options" heading={name} {at} {sheet} inside={[button]} items={[
      { label: 'Rename album', icon: 'i-lucide-pencil', testid: 'album-rename', run: onrename },
      { label: 'Delete album', icon: 'i-lucide-trash-2', testid: 'album-delete', danger: true, run: ondelete },
    ]} onClose={(focus) => { at = null; if (focus) button?.focus(); }} />
  {/if}
</span>
