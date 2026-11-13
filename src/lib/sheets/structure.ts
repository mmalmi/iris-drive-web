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

  /** The range with new ends where the move would bend it, and whether the move touches it at all. */
  const fixRef = (ref: RefSpec, home: Sheet): { fixed: RefSpec | null; touched: boolean } => {
    if (!ref.resolved || !ref.b || (ref.sheet ?? home.id) !== sheet.id) return { fixed: null, touched: false };
    const a = axis === 'row' ? ref.a.row : ref.a.col;
    const b = axis === 'row' ? ref.b.row : ref.b.col;
    if (a === null || b === null) return { fixed: null, touched: false };
    const span = live.span(a, b);
    if (!span) return { fixed: null, touched: false };
    const touched = from <= span[1] && lastMoved >= span[0];
    const ends = newEnds(span[0], span[1]);
    if (!ends || (ends[0] === a && ends[1] === b)) return { fixed: null, touched };
    return {
      touched,
      fixed: axis === 'row'
        ? { ...ref, a: { ...ref.a, row: ends[0] }, b: { ...ref.b, row: ends[1] } }
        : { ...ref, a: { ...ref.a, col: ends[0] }, b: { ...ref.b, col: ends[1] } },
    };
  };

  book.transact(() => {
    for (const info of book.sheets) {
      const home = book.sheet(info.id);
      for (const [key, raw] of [...home.cells.entries()]) {
        if (!isFormula(raw) || !raw.includes(']:[')) continue;
        let touched = false;
        let out = '=';
        for (const token of tokenize(raw.slice(1), 'id')) {
          const fix = token.type === 'ref' && token.ref ? fixRef(token.ref, home) : null;
          if (fix?.touched) touched = true;
          out += fix?.fixed ? writeIdRef(fix.fixed) : token.text;
        }
        // Written even when unchanged: should another device move the same
        // rows at once, its formula and its place then win or lose together
        // with this one's (see model.ts).
        if (touched) home.cells.set(key, out);
      }
    }
    // Merged blocks keep their rows together the same way.
    for (const merge of sheet.merges()) {
      const [low, high] = axis === 'row' ? [merge.r1, merge.r2] : [merge.c1, merge.c2];
      const ends = newEnds(low, high);
      if (!ends) continue;
      const rows = axis === 'row' ? ends : [sheet.rows.ids[merge.r1], sheet.rows.ids[merge.r2]];
      const cols = axis === 'col' ? ends : [sheet.cols.ids[merge.c1], sheet.cols.ids[merge.c2]];
      sheet.props.delete(merge.key);
      sheet.props.set(`m:${rows[0]}:${cols[0]}`, `${rows[1]}:${cols[1]}`);
    }
    sheet.move(axis, from, count, to);
  });
}

/** Rewrites the references of every formula in the book; `replace` returns null to leave one as it is. */
function rewriteFormulas(book: Book, replace: (ref: RefSpec, home: Sheet) => RefSpec | null): void {
  for (const info of book.sheets) {
    const home = book.sheet(info.id);
    for (const [key, raw] of [...home.cells.entries()]) {
      if (!isFormula(raw) || !raw.includes('[')) continue;
      let changed = false;
      let out = '=';
      for (const token of tokenize(raw.slice(1), 'id')) {
        const next = token.type === 'ref' && token.ref?.resolved ? replace(token.ref, home) : null;
        if (next) changed = true;
        out += next ? writeIdRef(next) : token.text;
      }
      if (changed && out !== raw) home.cells.set(key, out);
    }
  }
}

/**
 * A formula taken from one sheet to another as it is, still reading the
 * same cells: references to its old sheet name that sheet, and those to its
 * new sheet need no name.
 */
export function requalify(stored: string, from: Sheet, to: Sheet): string {
  if (from === to) return stored;
  let out = '=';
  for (const token of tokenize(stored.slice(1), 'id')) {
    const ref = token.ref;
    if (token.type !== 'ref' || !ref?.resolved) {
      out += token.text;
      continue;
    }
    const sheet = ref.sheet ?? from.id;
    out += writeIdRef({ ...ref, sheet: sheet === to.id ? null : sheet });
  }
  return out;
}

/**
 * After cells were cut and pasted elsewhere: formulas anywhere that read
 * them read them at their new place. `moved` maps "rowId:colId" on `source`
 * to the same on `target`. A range follows when all of it was moved.
 */
export function followMovedCells(book: Book, source: Sheet, target: Sheet, moved: Map<string, string>): void {
  if (moved.size === 0) return;
  const place = (row: string | null, col: string | null) => (row === null || col === null ? undefined : moved.get(`${row}:${col}`));
  const split = (key: string) => {
    const at = key.indexOf(':');
    return { row: key.slice(0, at), col: key.slice(at + 1) };
  };
  rewriteFormulas(book, (ref, home) => {
    if ((ref.sheet ?? home.id) !== source.id) return null;
    const sheet = target.id === home.id ? null : target.id;
    const first = place(ref.a.row, ref.a.col);
    if (!first) return null;
    if (!ref.b) return { ...ref, sheet, a: { ...ref.a, ...split(first) } };
    const second = place(ref.b.row, ref.b.col);
    if (!second) return null;
    // Every cell of the range must have moved, not only its corners.
    const rows = source.rows.span(ref.a.row as string, ref.b.row as string);
    const cols = source.cols.span(ref.a.col as string, ref.b.col as string);
    if (!rows || !cols) return null;
    for (let row = rows[0]; row <= rows[1]; row += 1) {
      for (let col = cols[0]; col <= cols[1]; col += 1) {
        if (!moved.has(`${source.rows.ids[row]}:${source.cols.ids[col]}`)) return null;
      }
    }
    return { ...ref, sheet, a: { ...ref.a, ...split(first) }, b: { ...ref.b, ...split(second) } };
  });
}

/**
 * Rows (or columns) were just inserted beside `edge`, from inside the
 * ranges that end there: those ranges take them in, as a total over a list
 * takes in a line added at the end of the list.
 */
export function widenRangesAtEdge(book: Book, sheet: Sheet, axis: 'row' | 'col', edge: string, added: string[], after: boolean): void {
  if (added.length === 0) return;
  const live = axis === 'row' ? sheet.rows : sheet.cols;
  const outer = after ? added[added.length - 1] : added[0];
  rewriteFormulas(book, (ref, home) => {
    if (!ref.b || (ref.sheet ?? home.id) !== sheet.id) return null;
    const a = axis === 'row' ? ref.a.row : ref.a.col;
    const b = axis === 'row' ? ref.b.row : ref.b.col;
    if (a === null || b === null) return null;
    const aAt = live.indexOf(a);
    const bAt = live.indexOf(b);
    if (aAt < 0 || bAt < 0) return null;
    // The end on the side the new ones were added.
    const lowIsA = aAt <= bAt;
    const end = after === lowIsA ? 'b' : 'a';
    if ((end === 'a' ? a : b) !== edge) return null;
    const moved = { ...(end === 'a' ? ref.a : ref.b), [axis]: outer };
    return end === 'a' ? { ...ref, a: moved } : { ...ref, b: moved };
  });
}
