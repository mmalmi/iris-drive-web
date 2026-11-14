<script lang="ts" module>
  /** One choice of a menu: something to do, or somewhere to go. */
  export interface MenuItem {
    label: string;
    icon: string;
    testid: string;
    run?: () => void;
    href?: string;
    /** For a link that opens in a new tab. */
    external?: boolean;
    danger?: boolean;
    disabled?: boolean;
    /** Classes for the item, such as one shown only on a phone. */
    class?: string;
  }
</script>

<script lang="ts">
  /**
   * A menu of actions: below its button, at a point (a right click), or on a
   * phone as a sheet rising from the bottom of the screen, as the New menu
   * does. The first item takes the keyboard; the arrow keys move between
   * items, and Escape, Tab, a click beside it or leaving the page close it.
   */
  import { tick } from 'svelte';

  interface Props {
    items: MenuItem[];
    label: string;
    /** Where it opens: at a point of the window, or else below the element it is placed in. */
    at?: { x: number; y: number } | null;
    sheet?: boolean;
    /** Shown at the top of the sheet: what the menu is for. */
    heading?: string | null;
    /** Elements a press on does not close it, such as the button that opened it. */
    inside?: (HTMLElement | null | undefined)[];
    testid?: string;
    onClose: (returnFocus: boolean) => void;
  }

  let { items, label, at = null, sheet = false, heading = null, inside = [], testid, onClose }: Props = $props();

  let menuRef: HTMLDivElement | undefined = $state();
  let backdropRef: HTMLDivElement | undefined = $state();
  let place = $state<{ left: number; top: number } | null>(null);

  /** The items the keyboard can go to: not disabled, and shown at this width. */
  function menuItems(): HTMLElement[] {
    return menuRef
      ? [...menuRef.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')].filter((item) => item.getClientRects().length > 0)
      : [];
  }

  // At a point, kept inside the window; then the first item takes the keyboard.
  $effect(() => {
    const point = at;
    const asSheet = sheet;
    void (async () => {
      await tick();
      if (!menuRef) return;
      if (point && !asSheet) {
        const { width, height } = menuRef.getBoundingClientRect();
        const left = Math.max(8, Math.min(point.x, window.innerWidth - width - 8));
        const top = point.y + height + 8 <= window.innerHeight ? point.y : Math.max(8, point.y - height);
        place = { left, top };
        // Hidden until placed, and what is hidden cannot take the keyboard.
        await tick();
      }
      menuItems()[0]?.focus();
    })();
  });

  $effect(() => {
    const isInside = (target: EventTarget | null) => target instanceof Node
      && [menuRef, backdropRef, ...inside].some((node) => node?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!isInside(event.target)) onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    const onAway = () => onClose(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('hashchange', onAway);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('hashchange', onAway);
    };
  });

  function onMenuKeydown(event: KeyboardEvent) {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    else if (event.key === 'Tab') {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (next < 0) return;
    event.preventDefault();
    list[next]?.focus();
  }

  function choose(event: MouseEvent, item: MenuItem) {
    if (item.disabled) {
      event.preventDefault();
      return;
    }
    // What the item does is done while its menu is still there; a dialog it
    // opens then takes the keyboard from the button the menu goes back to.
    item.run?.();
    // A link goes where it leads; the menu closes on the way.
    onClose(!item.href);
  }

  let position = $derived(
    sheet
      ? 'fixed left-0 right-0 bottom-0 rounded-t-2xl pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]'
      : at
        ? 'fixed w-56 rounded-xl py-1'
        : 'absolute right-0 top-full mt-1 w-56 rounded-xl py-1',
  );
  let style = $derived(
    sheet || !at ? undefined : place ? `left: ${place.left}px; top: ${place.top}px;` : `left: ${at.x}px; top: ${at.y}px; visibility: hidden;`,
  );
  let itemClass = $derived(sheet ? 'gap-4 px-5 h-13 text-base' : 'gap-3 px-4 h-10 text-sm');
</script>

{#if sheet}
  <!-- A tap beside the sheet only closes it. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div bind:this={backdropRef} class="fixed inset-0 z-40 bg-black/40" onclick={() => onClose(false)}></div>
{/if}
<div
  bind:this={menuRef}
  role="menu"
  tabindex="-1"
  aria-label={label}
  data-testid={testid}
  class="z-50 overflow-hidden bg-surface-1 shadow-lg ring-1 ring-surface-3 {position}"
  {style}
  onkeydown={onMenuKeydown}
  oncontextmenu={(event) => event.preventDefault()}
>
  {#if sheet && heading}
    <div class="px-5 pb-2 pt-1 mb-1.5 border-b border-surface-3/70 truncate text-sm font-medium text-text-2" title={heading}>{heading}</div>
  {/if}
  {#each items as item (item.testid)}
    {@const classes = `flex w-full items-center border-none bg-transparent text-left no-underline outline-none cursor-pointer hover:bg-surface-2 focus-visible:bg-surface-2 aria-disabled:opacity-50 aria-disabled:cursor-default ${item.danger ? 'text-danger' : 'text-text-1'} ${itemClass} ${item.class ?? ''}`}
    {#if item.danger}<div class="my-1.5 h-px bg-surface-3/70 {item.class ?? ''}" role="separator"></div>{/if}
    <svelte:element
      this={item.href ? 'a' : 'button'}
      type={item.href ? undefined : 'button'}
      href={item.href}
      target={item.external ? '_blank' : undefined}
      rel={item.external ? 'noreferrer' : undefined}
      role="menuitem"
      tabindex="-1"
      class={classes}
      aria-disabled={item.disabled ? 'true' : undefined}
      data-testid={item.testid}
      onclick={(event: MouseEvent) => choose(event, item)}
    >
      <span class="{item.icon} shrink-0 {sheet ? 'text-xl' : 'text-lg'} {item.danger ? '' : 'text-text-2'}"></span>
      {item.label}
    </svelte:element>
  {/each}
</div>
