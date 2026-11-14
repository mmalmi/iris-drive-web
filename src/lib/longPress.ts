/**
 * A long press with a finger or a pen, for opening a menu: iOS sends no
 * contextmenu event for one. `onPress` gets where the finger is. A finger
 * that moves is scrolling, not pressing, and the click that ends a press
 * only lifts the finger.
 *
 * There is one finger's press at a time, kept here rather than with the
 * element: a list that is drawn again while the finger is down (a change
 * arriving from another device) still gets the press and its end.
 */
const LONG_PRESS_MS = 500;
const MOVE_LIMIT_PX = 10;

let timer: ReturnType<typeof setTimeout> | null = null;
let start: { x: number; y: number } | null = null;
let pressed = false;

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function move(event: PointerEvent) {
  if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_LIMIT_PX) stop();
}

// Android's own long press is the same press, told by a contextmenu event.
function context() {
  if (!start) return;
  stop();
  pressed = true;
}

function click(event: MouseEvent) {
  if (!pressed) return;
  event.preventDefault();
  pressed = false;
}

export function longPress(node: HTMLElement, onPress: (at: { x: number; y: number }) => void) {
  let handler = onPress;
  const down = (event: PointerEvent) => {
    pressed = false;
    start = null;
    stop();
    if (event.pointerType === 'mouse') return;
    const at = { x: event.clientX, y: event.clientY };
    start = at;
    timer = setTimeout(() => {
      timer = null;
      pressed = true;
      handler(at);
    }, LONG_PRESS_MS);
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
  node.addEventListener('contextmenu', context);
  node.addEventListener('click', click);
  return {
    update(next: (at: { x: number; y: number }) => void) {
      handler = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', stop);
      node.removeEventListener('pointercancel', stop);
      node.removeEventListener('contextmenu', context);
      node.removeEventListener('click', click);
    },
  };
}
