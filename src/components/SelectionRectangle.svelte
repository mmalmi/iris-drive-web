<script lang="ts">
  /**
   * Choosing rows of a folder's list by drawing a rectangle over it with the
   * mouse, as in Google Drive. It starts on empty space: not on a link, a
   * button or a field, so a row is still dragged to move it, and never with a
   * finger, so a phone keeps scrolling. Every row it touches is chosen, added
   * to what was with Ctrl/⌘, and the list scrolls when the pointer reaches
   * its top or bottom. Placed inside the list, which it draws over.
   */
  import type { ListSelection } from '../lib/listSelection.svelte';

  interface Props {
    list: HTMLElement | undefined;
    selection: ListSelection;
  }

  let { list, selection }: Props = $props();

  /** How far the pointer moves before the rectangle shows. */
  const MIN_MOVE_PX = 4;
  /** How near the top or bottom the list starts scrolling, and how far each frame. */
  const EDGE_PX = 32;
  const SCROLL_PX = 14;

  /** Where the rectangle is, in the list's scrolled content. */
  let rect = $state<{ left: number; top: number; width: number; height: number } | null>(null);

  $effect(() => {
    const node = list;
    if (!node) return;
    let origin: { x: number; y: number } | null = null;
    let pointer = { x: 0, y: 0 };
    let frame = 0;

    const inList = (x: number, y: number) => {
      const place = node.getBoundingClientRect();
      return { x: x - place.left + node.scrollLeft, y: y - place.top + node.scrollTop };
    };

    const draw = () => {
      if (!origin) return;
      const at = inList(pointer.x, pointer.y);
      if (!rect && Math.hypot(at.x - origin.x, at.y - origin.y) < MIN_MOVE_PX) return;
      const top = Math.min(origin.y, at.y);
      const bottom = Math.max(origin.y, at.y);
      rect = { left: Math.min(origin.x, at.x), top, width: Math.abs(at.x - origin.x), height: bottom - top };
      const contentTop = node.getBoundingClientRect().top - node.scrollTop;
      selection.band([...node.querySelectorAll<HTMLElement>('[data-entry-name]')]
        .filter((row) => {
          const place = row.getBoundingClientRect();
          return place.top - contentTop < bottom && place.bottom - contentTop > top;
        })
        .map((row) => row.dataset.entryName!));
    };

    // At the top or bottom edge the list scrolls, on its own while the pointer stays there.
    const scroll = () => {
      frame = 0;
      if (!origin) return;
      const place = node.getBoundingClientRect();
      const before = node.scrollTop;
      node.scrollTop += pointer.y < place.top + EDGE_PX ? -SCROLL_PX : pointer.y > place.bottom - EDGE_PX ? SCROLL_PX : 0;
      if (node.scrollTop === before) return;
      draw();
      frame = requestAnimationFrame(scroll);
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      if (!(event.target instanceof Element) || event.target.closest('a, button, input, label, [role="menu"]')) return;
      const place = node.getBoundingClientRect();
      // Not on the scrollbar, and only where there are rows to choose.
      if (event.clientX - place.left >= node.clientWidth || event.clientY - place.top >= node.clientHeight) return;
      if (!node.querySelector('[data-entry-name]')) return;
      event.preventDefault();
      node.focus();
      node.setPointerCapture(event.pointerId);
      origin = inList(event.clientX, event.clientY);
      pointer = { x: event.clientX, y: event.clientY };
      selection.startBand(event.ctrlKey || event.metaKey);
    };

    const move = (event: PointerEvent) => {
      if (!origin) return;
      pointer = { x: event.clientX, y: event.clientY };
      draw();
      if (!frame) frame = requestAnimationFrame(scroll);
    };

    const end = (event: PointerEvent) => {
      if (!origin) return;
      origin = null;
      rect = null;
      cancelAnimationFrame(frame);
      frame = 0;
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
      cancelAnimationFrame(frame);
      rect = null;
    };
  });
</script>

{#if rect}
  <div
    class="absolute z-10 pointer-events-none border border-accent bg-accent/15 rounded-sm"
    style="left: {rect.left}px; top: {rect.top}px; width: {rect.width}px; height: {rect.height}px;"
    data-testid="selection-rectangle"
  ></div>
{/if}
