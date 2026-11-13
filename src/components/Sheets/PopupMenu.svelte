<script lang="ts" module>
  export interface MenuItem {
    label: string;
    /** An icon class such as "i-lucide-copy". */
    icon?: string;
    /** A keyboard shortcut shown beside the label. */
    hint?: string;
    action: () => void;
    disabled?: boolean;
    checked?: boolean;
    danger?: boolean;
    /** Draws a line above this item. */
    divider?: boolean;
    testId?: string;
  }
</script>

<script lang="ts">
  /** A list of actions shown at a point on screen, closed by choosing, Escape or a click elsewhere. */
  import { onMount } from 'svelte';

  interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    onclose: () => void;
  }
  let { x, y, items, onclose }: Props = $props();

  let element: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);
  let placed = $state(false);

  onMount(() => {
    if (!element) return undefined;
    // Kept on screen: flipped to the other side of the point when there is no room.
    const { width, height } = element.getBoundingClientRect();
    left = Math.max(4, x + width > window.innerWidth - 4 ? Math.min(x - width, window.innerWidth - width - 4) : x);
    top = Math.max(4, y + height > window.innerHeight - 4 ? Math.min(y - height, window.innerHeight - height - 4) : y);
    placed = true;
    element.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!element?.contains(event.target as Node)) onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', onclose);
    window.addEventListener('blur', onclose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', onclose);
      window.removeEventListener('blur', onclose);
    };
  });

  function choose(item: MenuItem): void {
    if (item.disabled) return;
    onclose();
    item.action();
  }

  function onkeydown(event: KeyboardEvent): void {
    const buttons = [...(element?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      onclose();
    } else if (event.key === 'ArrowDown') {
      buttons[(current + 1) % buttons.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      buttons[(current - 1 + buttons.length) % buttons.length]?.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
</script>

<div
  bind:this={element}
  class="menu"
  class:placed
  style="left: {left}px; top: {top}px"
  role="menu"
  tabindex="-1"
  data-testid="sheet-menu"
  {onkeydown}
  oncontextmenu={event => event.preventDefault()}
>
  {#each items as item (item.label)}
    {#if item.divider}<div class="line"></div>{/if}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:danger={item.danger}
      disabled={item.disabled}
      data-testid={item.testId}
      onclick={() => choose(item)}
    >
      <span class="icon {item.checked ? 'i-lucide-check' : item.icon ?? ''}"></span>
      <span class="label">{item.label}</span>
      {#if item.hint}<span class="hint">{item.hint}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 200px;
    max-width: min(320px, calc(100vw - 8px));
    max-height: calc(100vh - 8px);
    overflow-y: auto;
    padding: 4px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-1));
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.22);
    visibility: hidden;
    outline: none;
  }

  .menu.placed {
    visibility: visible;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 4px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }

  .item:hover:not(:disabled),
  .item:focus-visible {
    background: rgb(var(--surface-2));
    outline: none;
  }

  .item:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .item.danger {
    color: #e5484d;
  }

  .icon {
    flex: none;
    width: 16px;
    font-size: 0.95rem;
    color: rgb(var(--text-2));
  }

  .danger .icon {
    color: inherit;
  }

  .label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hint {
    flex: none;
    color: rgb(var(--text-3));
    font-size: 0.75rem;
  }

  .line {
    height: 1px;
    margin: 4px 6px;
    background: rgb(var(--surface-2));
  }

  @media (pointer: coarse) {
    .item {
      min-height: 40px;
    }
  }
</style>
