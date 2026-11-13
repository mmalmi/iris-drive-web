/**
 * What a finger does on the grid. The browser scrolls; a tap selects (two
 * taps open a cell for typing); a long press opens the menu; a finger on a
 * selection handle stretches the selection or fills, and one on a header
 * border resizes. Handles only take over once the finger moves, so tapping
 * near one still taps the cell under it.
 */
import type { CellPos } from '../../lib/sheets/address';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { columnX, hitTest, overTouchHandle, rowY, type Viewport } from '../../lib/sheets/layout';

export type TouchGrab =
  | { kind: 'fill' }
  | { kind: 'extend'; fixed: CellPos }
  | { kind: 'resize'; axis: 'row' | 'col'; index: number; origin: number; startSize: number };

export interface TouchHost {
  ctl: SheetController;
  view(): Viewport | null;
  /** A point on the page in the grid's own pixels. */
  local(point: { clientX: number; clientY: number }): { x: number; y: number };
  /** A finger came down at a point of the grid. */
  touched(x: number, y: number): void;
  grab(what: TouchGrab): void;
  dragging(): boolean;
  dragTo(x: number, y: number): void;
  /** The finger lifted after dragging. */
  release(): void;
  /** The finger lifted without moving: the grab is forgotten. */
  letGo(): void;
  tap(x: number, y: number): void;
  longPress(x: number, y: number, clientX: number, clientY: number): void;
}

const LONG_PRESS_MS = 500;
/** How near a header border a finger must be to resize. */
const GRIP = 10;

/** The border between two headers under a finger, for resizing. */
function headerEdgeAt(view: Viewport, x: number, y: number): { axis: 'row' | 'col'; index: number } | null {
  const hit = hitTest(view, x, y);
  if (hit.area === 'colHeader') {
    const start = columnX(view, hit.col);
    const end = start + view.cols.size(hit.col);
    if (end - x <= GRIP) return { axis: 'col', index: hit.col };
    if (x - start <= GRIP && hit.col > 0) return { axis: 'col', index: hit.col - 1 };
  } else if (hit.area === 'rowHeader') {
    const start = rowY(view, hit.row);
    const end = start + view.rows.size(hit.row);
    if (end - y <= GRIP / 2) return { axis: 'row', index: hit.row };
    if (y - start <= GRIP / 2 && hit.row > 0) return { axis: 'row', index: hit.row - 1 };
  }
  return null;
}

/** Listens to the fingers on `surface`; returns what stops listening. */
export function listenToTouch(surface: HTMLElement, host: TouchHost): () => void {
  /** A finger held on the grid: when it stays long enough, the menu opens. */
  let press: { x: number; y: number; clientX: number; clientY: number; timer: ReturnType<typeof setTimeout>; fired: boolean; moved: boolean } | null = null;
  /** Where a finger took a handle or a header border. */
  let grip: { x: number; y: number; moved: boolean } | null = null;

  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  const onStart = (event: TouchEvent) => {
    cancelPress();
    const view = host.view();
    const { ctl } = host;
    if (event.touches.length !== 1 || !view || !ctl.hasSheet) {
      // A second finger means pinching or scrolling, not selecting.
      if (host.dragging()) host.release();
      return;
    }
    grip = null;
    const touch = event.touches[0];
    const { x, y } = host.local(touch);
    host.touched(x, y);
    if (!ctl.edit) {
      const handle = overTouchHandle(view, ctl.selection, x, y, ctl.canEdit);
      const edge = handle || !ctl.canEdit ? null : headerEdgeAt(view, x, y);
      if (handle || edge) {
        // The finger drags the handle instead of scrolling the grid.
        event.preventDefault();
        const rect = ctl.selection;
        if (edge) {
          const size = edge.axis === 'col' ? view.cols.size(edge.index) : view.rows.size(edge.index);
          host.grab({ kind: 'resize', axis: edge.axis, index: edge.index, origin: edge.axis === 'col' ? x : y, startSize: size });
        } else if (handle === 'fill') {
          host.grab({ kind: 'fill' });
        } else {
          host.grab({ kind: 'extend', fixed: handle === 'end' ? { row: rect.r1, col: rect.c1 } : { row: rect.r2, col: rect.c2 } });
        }
        grip = { x, y, moved: false };
        return;
      }
    }
    const { clientX, clientY } = touch;
    press = {
      x,
      y,
      clientX,
      clientY,
      fired: false,
      moved: false,
      timer: setTimeout(() => {
        if (!press) return;
        press.fired = true;
        navigator.vibrate?.(8);
        host.longPress(press.x, press.y, press.clientX, press.clientY);
      }, LONG_PRESS_MS),
    };
  };

  const onMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    const { x, y } = host.local(touch);
    if (host.dragging()) {
      event.preventDefault();
      if (grip && !grip.moved && Math.hypot(x - grip.x, y - grip.y) > 6) grip.moved = true;
      if (grip?.moved !== false) host.dragTo(x, y);
      return;
    }
    if (press && !press.moved && Math.hypot(x - press.x, y - press.y) > 10) {
      // Scrolling, not pressing.
      clearTimeout(press.timer);
      press.moved = true;
    }
  };

  const onEnd = (event: TouchEvent) => {
    if (host.dragging()) {
      event.preventDefault();
      const held = grip;
      grip = null;
      if (held && !held.moved) {
        // Only touched, not dragged: a tap on what lies under the handle.
        host.letGo();
        host.tap(held.x, held.y);
      } else {
        host.release();
      }
      return;
    }
    const ended = press;
    cancelPress();
    if (!ended || ended.moved) return;
    // A tap is taken here rather than from the click that follows, which a
    // quick second tap does not always get. After a long press, lifting the
    // finger is not also a tap.
    event.preventDefault();
    if (!ended.fired) host.tap(ended.x, ended.y);
  };

  const options = { passive: false } as const;
  surface.addEventListener('touchstart', onStart, options);
  surface.addEventListener('touchmove', onMove, options);
  surface.addEventListener('touchend', onEnd, options);
  surface.addEventListener('touchcancel', onEnd, options);
  return () => {
    cancelPress();
    surface.removeEventListener('touchstart', onStart);
    surface.removeEventListener('touchmove', onMove);
    surface.removeEventListener('touchend', onEnd);
    surface.removeEventListener('touchcancel', onEnd);
  };
}

/**
 * Calls back with how much of `element`'s bottom an on-screen keyboard
 * covers, whenever that changes. Returns what stops watching.
 */
export function watchKeyboard(element: HTMLElement, onInset: (inset: number) => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const measure = () => {
    const bounds = element.getBoundingClientRect();
    onInset(Math.max(0, Math.round(bounds.bottom - (viewport.offsetTop + viewport.height))));
  };
  viewport.addEventListener('resize', measure);
  viewport.addEventListener('scroll', measure);
  return () => {
    viewport.removeEventListener('resize', measure);
    viewport.removeEventListener('scroll', measure);
  };
}
