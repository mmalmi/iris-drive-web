/** Border lines: how they are written down, and drawing them along cells. */
import type { Rect } from './address';
import type { Book, Sheet, StylePatch } from './model';

/** Kinds of border line: thin, medium, thick, dashed, dotted. */
export type BorderKind = 's' | 'm' | 'k' | 'd' | 'o';

export interface BorderLine {
  kind: BorderKind;
  /** As #rrggbb; empty for the text colour, which shows in a light and a dark theme alike. */
  color: string;
}

export function readBorder(value: string | undefined): BorderLine | null {
  if (!value) return null;
  const kind = value[0] as BorderKind;
  return { kind: 'smkdo'.includes(kind) ? kind : 's', color: value.slice(1) };
}

export type BorderPlace = 'all' | 'outer' | 'inner' | 'horizontal' | 'vertical' | 'top' | 'bottom' | 'left' | 'right' | 'none';

/**
 * Draws or removes lines along a rectangle of cells. A line between two
 * cells is kept on one of them, and taken off the other, so the two never
 * disagree. `line` null removes.
 */
export function setBorders(book: Book, sheet: Sheet, rect: Rect, where: BorderPlace, line: string | null): void {
  const { r1, c1, r2, c2 } = rect;
  const lastRow = sheet.rows.length - 1;
  const lastCol = sheet.cols.length - 1;
  const patch = (area: Rect, sides: StylePatch) => {
    if (area.r1 > area.r2 || area.c1 > area.c2 || area.r1 < 0 || area.c1 < 0 || area.r2 > lastRow || area.c2 > lastCol) return;
    sheet.patchStyle(area, sides);
  };
  const top = where === 'all' || where === 'outer' || where === 'top' || where === 'none';
  const bottom = where === 'all' || where === 'outer' || where === 'bottom' || where === 'none';
  const left = where === 'all' || where === 'outer' || where === 'left' || where === 'none';
  const right = where === 'all' || where === 'outer' || where === 'right' || where === 'none';
  const horizontal = where === 'all' || where === 'inner' || where === 'horizontal' || where === 'none';
  const vertical = where === 'all' || where === 'inner' || where === 'vertical' || where === 'none';
  book.transact(() => {
    if (top) {
      patch({ r1, c1, r2: r1, c2 }, { bt: line });
      patch({ r1: r1 - 1, c1, r2: r1 - 1, c2 }, { bb: null });
    }
    if (bottom) {
      patch({ r1: r2, c1, r2, c2 }, { bb: line });
      patch({ r1: r2 + 1, c1, r2: r2 + 1, c2 }, { bt: null });
    }
    if (left) {
      patch({ r1, c1, r2, c2: c1 }, { bl: line });
      patch({ r1, c1: c1 - 1, r2, c2: c1 - 1 }, { br: null });
    }
    if (right) {
      patch({ r1, c1: c2, r2, c2 }, { br: line });
      patch({ r1, c1: c2 + 1, r2, c2: c2 + 1 }, { bl: null });
    }
    if (horizontal && r2 > r1) {
      patch({ r1, c1, r2: r2 - 1, c2 }, { bb: line });
      patch({ r1: r1 + 1, c1, r2, c2 }, { bt: null });
    }
    if (vertical && c2 > c1) {
      patch({ r1, c1, r2, c2: c2 - 1 }, { br: line });
      patch({ r1, c1: c1 + 1, r2, c2 }, { bl: null });
    }
  });
}
