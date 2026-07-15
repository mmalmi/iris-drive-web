<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
    children: Snippet;
    label?: string;
    panelClass?: string;
    backdropClass?: string;
    closeOnEsc?: boolean;
    closeOnBackdrop?: boolean;
  }

  let {
    open,
    onClose,
    children,
    label,
    panelClass = '',
    backdropClass = 'fixed inset-0 z-50 flex items-center justify-center bg-black/70',
    closeOnEsc = true,
    closeOnBackdrop = true,
  }: Props = $props();

  function handleBackdropClick(event: MouseEvent) {
    if (!closeOnBackdrop || event.target !== event.currentTarget) return;
    onClose();
  }

  $effect(() => {
    if (!open || !closeOnEsc) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={backdropClass}
    data-modal-backdrop
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label={label}
    onclick={handleBackdropClick}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class={panelClass} onclick={(event) => event.stopPropagation()}>
      {@render children()}
    </div>
  </div>
{/if}
