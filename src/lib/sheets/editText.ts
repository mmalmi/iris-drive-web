/** Helpers for the text of a formula while it is being typed. */
import { columnIndex } from './address';
import { tokenize, type RefSpec } from './formula';
import { REF_COLORS } from './render';

export interface ReferenceSpan {
  /** Where the reference is in the text, counting the leading "=". */
  start: number;
  end: number;
  color: string;
  ref: RefSpec;
}

/** Every cell reference in a typed formula, each with its own colour. */
export function referenceSpans(text: string): ReferenceSpan[] {
  if (!text.startsWith('=')) return [];
  const spans: ReferenceSpan[] = [];
  // The same cells written twice share a colour.
  const colors = new Map<string, string>();
  for (const token of tokenize(text.slice(1), 'a1')) {
    if (token.type !== 'ref' || !token.ref) continue;
    const key = token.text.replace(/\$/g, '').toUpperCase();
    let color = colors.get(key);
    if (!color) colors.set(key, color = REF_COLORS[colors.size % REF_COLORS.length]);
    spans.push({ start: token.start + 1, end: token.end + 1, color, ref: token.ref });
  }
  return spans;
}

/** The rectangle a typed reference covers on a sheet with `rows` by `cols` cells, or null when it lies outside. */
export function spanRect(ref: RefSpec, rows: number, cols: number): { r1: number; c1: number; r2: number; c2: number } | null {
  const end = ref.b ?? ref.a;
  const r = [ref.a.row === null ? 0 : Number(ref.a.row) - 1, end.row === null ? rows - 1 : Number(end.row) - 1].sort((a, b) => a - b);
  const c = [ref.a.col === null ? 0 : columnIndex(ref.a.col), end.col === null ? cols - 1 : columnIndex(end.col)].sort((a, b) => a - b);
  if (r[0] >= rows || c[0] >= cols || r[0] < 0) return null;
  return { r1: r[0], c1: c[0], r2: Math.min(r[1], rows - 1), c2: Math.min(c[1], cols - 1) };
}

/** F4: the text with the reference at the caret switched to its next form: A1, $A$1, A$1, $A1. */
export function cycleAbsoluteAt(text: string, caret: number): { text: string; caret: number } | null {
  for (const span of referenceSpans(text)) {
    if (caret < span.start || caret > span.end) continue;
    const written = text.slice(span.start, span.end);
    const bang = written.lastIndexOf('!');
    const cycle = (part: string) => {
      const match = /^(\$?)([A-Za-z]*)(\$?)(\d*)$/.exec(part);
      if (!match) return part;
      const [, absCol, col, absRow, row] = match;
      const next = [3, 2, 0, 1][(absCol ? 2 : 0) + (absRow ? 1 : 0)];
      return `${next & 2 && col ? '$' : ''}${col}${next & 1 && row ? '$' : ''}${row}`;
    };
    const replaced = written.slice(0, bang + 1) + written.slice(bang + 1).split(':').map(cycle).join(':');
    return { text: text.slice(0, span.start) + replaced + text.slice(span.end), caret: span.start + replaced.length };
  }
  return null;
}
