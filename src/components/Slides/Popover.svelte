<script lang="ts">
  /** A small panel that opens beside a button or at a point, and closes on a click elsewhere or Escape. */
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    /** The button it belongs to, or the point it opens at. */
    anchor: HTMLElement | { x: number; y: number } | undefined;
    label: string;
    /** Rises from the bottom of the screen, full width, as on a phone. */
    sheet?: boolean;
    children: Snippet;
  }
  let { open = $bindable(), anchor, label, sheet = false, children }: Props = $props();

  let panel: HTMLElement | undefined = $state();
  let position = $state({ left: 0, top: 0 });

  $effect(() => {
    if (!open || !panel || !anchor || sheet) return;
    const size = panel.getBoundingClientRect();
    const at = anchor instanceof HTMLElement
      ? (() => {
          const rect = anchor.getBoundingClientRect();
          return { x: rect.left, y: rect.bottom + 6, above: rect.top - 6 };
        })()
      : { x: anchor.x, y: anchor.y, above: anchor.y };
    const left = Math.max(8, Math.min(at.x, window.innerWidth - size.width - 8));
    // Below when there is room, otherwise above.
    const top = at.y + size.height + 8 <= window.innerHeight ? at.y : Math.max(8, at.above - size.height);
    position = { left, top };
  });

  $effect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = event.target as Node | null;
      if (panel?.contains(target)) return;
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      open = false;
    };
    const onResize = () => (open = false);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  });
</script>

{#if open}
  <div
    class="popover"
    class:sheet
    bind:this={panel}
    role="dialog"
    aria-label={label}
    style:left={sheet ? undefined : `${position.left}px`}
    style:top={sheet ? undefined : `${position.top}px`}
    data-slides-popover
  >
    {@render children()}
  </div>
{/if}

<style>
  .popover {
    position: fixed;
    z-index: 60;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: auto;
    padding: 6px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 10px;
    background: rgb(var(--surface-1));
    color: rgb(var(--text-1));
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.22);
  }

  .popover.sheet {
    left: 0;
    right: 0;
    bottom: 0;
    max-width: none;
    max-height: 72vh;
    padding: 8px 10px max(12px, env(safe-area-inset-bottom));
    border-width: 1px 0 0;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -6px 28px rgb(0 0 0 / 0.22);
  }

  .popover :global(.menu-item) {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 34px;
    padding: 0 12px 0 10px;
    border-radius: 6px;
    font-size: 0.875rem;
    text-align: left;
    white-space: nowrap;
    color: rgb(var(--text-1));
  }

  .popover :global(.menu-item:hover:not(:disabled)),
  .popover :global(.menu-item:focus-visible) {
    background: rgb(var(--surface-2));
    outline: none;
  }

  .popover :global(.menu-item:disabled) {
    opacity: 0.4;
    cursor: default;
  }

  .popover :global(.menu-item .keys) {
    margin-left: auto;
    padding-left: 20px;
    font-size: 0.75rem;
    color: rgb(var(--text-3));
  }

  .popover :global(.menu-divider) {
    height: 1px;
    margin: 4px 6px;
    background: rgb(var(--surface-3));
  }

  .popover :global(.menu-label) {
    padding: 6px 10px 4px;
    font-size: 0.75rem;
    color: rgb(var(--text-2));
  }
</style>
