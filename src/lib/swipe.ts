/**
 * A quick sideways flick of one finger, as between photos in Google Drive on a phone:
 * `onSwipe(1)` for a flick to the left (the next one), `onSwipe(-1)` to the right.
 * Not while the page is pinch-zoomed, on a slider or player, or over something that
 * itself scrolls sideways: there the finger is panning.
 */
export function swipe(node: HTMLElement, onSwipe: (step: 1 | -1) => void) {
  let start: { x: number; y: number; at: number } | null = null;

  const scrollsSideways = (target: Element): boolean => {
    for (let el: Element | null = target; el && el !== node; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
    }
    return false;
  };

  const down = (e: TouchEvent) => {
    const target = e.target as Element;
    const usable = e.touches.length === 1 && (window.visualViewport?.scale ?? 1) === 1
      && !target.closest('input, video, audio, [role="slider"]') && !scrollsSideways(target);
    start = usable ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, at: e.timeStamp } : null;
  };

  const up = (e: TouchEvent) => {
    const from = start;
    start = null;
    const touch = e.changedTouches[0];
    if (!from || !touch || e.touches.length > 0 || e.timeStamp - from.at > 600) return;
    const dx = touch.clientX - from.x;
    const dy = touch.clientY - from.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    onSwipe(dx < 0 ? 1 : -1);
  };

  const cancel = () => { start = null; };
  node.addEventListener('touchstart', down, { passive: true });
  node.addEventListener('touchend', up, { passive: true });
  node.addEventListener('touchcancel', cancel, { passive: true });
  return {
    update(next: (step: 1 | -1) => void) { onSwipe = next; },
    destroy() {
      node.removeEventListener('touchstart', down);
      node.removeEventListener('touchend', up);
      node.removeEventListener('touchcancel', cancel);
    },
  };
}
