/** Reorganising rows and columns in ways that need to look at formulas. */
import { tokenize, writeIdRef, type RefSpec } from './formula';
import { isFormula, type Book, type Sheet } from './model';

/**
 * Moves rows or columns so they sit before the one now at `to`.
 *
 * A range in a formula is held by the ids of its two ends, so moving an end
 * would stretch or shrink the range. People expect otherwise: rows shuffled
 * inside a summed range are all still summed, and a row dragged out of it no
 * longer is. The ranges that the move would bend are therefore given new
 * ends in the same step.
 */
export function moveKeepingRanges(book: Book, sheet: Sheet, axis: 'row' | 'col', from: number, count: number, to: number): void {
  const live = axis === 'row' ? sheet.rows : sheet.cols;
  if (count <= 0 || from < 0 || from + count > live.length) return;
  if (to >= from && to <= from + count) return;
  const before = [...live.ids];
  const moved = before.slice(from, from + count);
  const rest = [...before.slice(0, from), ...before.slice(from + count)];
  const landing = to > from ? to - count : to;
  const after = [...rest.slice(0, landing), ...moved, ...rest.slice(landing)];
  const positionAfter = new Map(after.map((id, index) => [id, index]));
  const lastMoved = from + count - 1;

  /** New end ids for a range that covered positions low..high, or null to leave it alone. */
  const newEnds = (low: number, high: number): [string, string] | null => {
    const touches = from <= high && lastMoved >= low;
    const swallowed = from <= low && lastMoved >= high;
    if (!touches || swallowed) return null;
    const inside = from >= low && lastMoved <= high;
    if (inside && to >= low && to <= high + 1) return [after[low], after[high]];
    let first = Infinity;
    let last = -Infinity;
    for (let index = low; index <= high; index += 1) {
      if (index >= from && index <= lastMoved) continue;
      const position = positionAfter.get(before[index]) as number;
      if (position < first) first = position;
      if (position > last) last = position;
    }
    return [after[first], after[last]];
  };

  const fixRef = (ref: RefSpec, home: Sheet): RefSpec | null => {
    if (!ref.resolved || !ref.b || (ref.sheet ?? home.id) !== sheet.id) return null;
    const a = axis === 'row' ? ref.a.row : ref.a.col;
    const b = axis === 'row' ? ref.b.row : ref.b.col;
    if (a === null || b === null) return null;
    const span = live.span(a, b);
    if (!span) return null;
    const ends = newEnds(span[0], span[1]);
    if (!ends || (ends[0] === a && ends[1] === b)) return null;
    return axis === 'row'
      ? { ...ref, a: { ...ref.a, row: ends[0] }, b: { ...ref.b, row: ends[1] } }
      : { ...ref, a: { ...ref.a, col: ends[0] }, b: { ...ref.b, col: ends[1] } };
  };

  book.transact(() => {
    for (const info of book.sheets) {
      const home = book.sheet(info.id);
      for (const [key, raw] of [...home.cells.entries()]) {
        if (!isFormula(raw) || !raw.includes(']:[')) continue;
        let changed = false;
        let out = '=';
        for (const token of tokenize(raw.slice(1), 'id')) {
          const fixed = token.type === 'ref' && token.ref ? fixRef(token.ref, home) : null;
          if (fixed) changed = true;
          out += fixed ? writeIdRef(fixed) : token.text;
        }
        if (changed) home.cells.set(key, out);
      }
    }
    sheet.move(axis, from, count, to);
  });
}
