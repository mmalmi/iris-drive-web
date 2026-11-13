/** Keeping what did not change from one reading of the deck to the next, so only what changed is redrawn. */
import type { Slide } from './model';

function shallowEqual(left: object, right: object): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/** Keeps the objects of the previous reading where nothing changed, so only what changed is redrawn. */
export function reuse(previous: Slide | undefined, next: Slide): Slide {
  if (!previous) return next;
  const before = new Map(previous.elements.map(element => [element.id, element]));
  const elements = next.elements.map((element) => {
    const old = before.get(element.id);
    if (!old) return element;
    // A table is read afresh each time; it is the same when its grid is.
    if (old.table && element.table) {
      return old.table.signature === element.table.signature && shallowEqual({ ...old, table: null }, { ...element, table: null }) ? old : element;
    }
    return shallowEqual(old, element) ? old : element;
  });
  const same = elements.length === previous.elements.length
    && elements.every((element, index) => element === previous.elements[index])
    && previous.pos === next.pos && previous.layout === next.layout
    && previous.background === next.background && previous.notes === next.notes
    && previous.transition === next.transition && previous.build === next.build;
  return same ? previous : { ...next, elements };
}
