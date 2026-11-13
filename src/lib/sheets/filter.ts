/**
 * Filtering, sorting and finding.
 *
 * A filter belongs to the person looking, not to the sheet: it is kept in
 * the browser tab and never stored. Several people work in one spreadsheet
 * and their saves merge seconds later; a stored filter would hide rows from
 * someone in the middle of working on them, and could not be used at all by
 * someone who may only read. Sorting, in contrast, rearranges the cells and
 * is stored like any other edit (for a reader it changes only their copy).
 */
import type { CellPos, Rect } from './address';
import type { Engine } from './engine';
import { cellKey, isFormula, type CellRaw, type CellStyle, type Sheet } from './model';
import { compareValues, isError, textToNumber, type Scalar } from './values';

export type ConditionKind = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'greater' | 'less' | 'empty' | 'notEmpty';

export const CONDITION_LABELS: Record<ConditionKind, string> = {
  contains: 'Contains',
  notContains: 'Does not contain',
  equals: 'Is exactly',
  startsWith: 'Starts with',
  greater: 'Greater than',
  less: 'Less than',
  empty: 'Is empty',
  notEmpty: 'Is not empty',
};

export interface ColumnFilter {
  /** Shown texts whose rows are left out; "" stands for empty cells. */
  excluded: ReadonlySet<string>;
  condition: { kind: ConditionKind; value: string } | null;
}

/** A filter over the columns from `firstColId` to `lastColId`, for the rows under the header row. */
export interface SheetFilter {
  headerRowId: string;
  firstColId: string;
  lastColId: string;
  columns: ReadonlyMap<string, ColumnFilter>;
}

/** The header row and the rows under it that the filter looks at, or null when its rows or columns are gone. */
export function filterRect(sheet: Sheet, filter: SheetFilter): Rect | null {
  const header = sheet.rows.indexOf(filter.headerRowId);
  const span = sheet.cols.span(filter.firstColId, filter.lastColId);
  if (header < 0 || !span) return null;
  return { r1: header, c1: span[0], r2: Math.max(header, sheet.usedRect()?.r2 ?? header), c2: span[1] };
}

function conditionHolds(condition: NonNullable<ColumnFilter['condition']>, value: Scalar, text: string): boolean {
  const wanted = condition.value.trim();
  const lower = text.toLowerCase();
  switch (condition.kind) {
    case 'contains': return lower.includes(wanted.toLowerCase());
    case 'notContains': return !lower.includes(wanted.toLowerCase());
    case 'equals': return lower === wanted.toLowerCase();
    case 'startsWith': return lower.startsWith(wanted.toLowerCase());
    case 'empty': return text === '';
    case 'notEmpty': return text !== '';
    case 'greater':
    case 'less': {
      const limit = textToNumber(wanted);
      if (limit === null || typeof value !== 'number') return false;
      return condition.kind === 'greater' ? value > limit : value < limit;
    }
    default: return true;
  }
}

function columnPasses(filter: ColumnFilter, value: Scalar, text: string): boolean {
  if (filter.excluded.has(text)) return false;
  return !filter.condition || conditionHolds(filter.condition, value, text);
}

/** Positions of the rows a filter leaves out. `except` ignores one column's choices, to list what it could show. */
export function filteredOutRows(sheet: Sheet, engine: Engine, filter: SheetFilter, except?: string): Set<number> {
  const out = new Set<number>();
  const rect = filterRect(sheet, filter);
  if (!rect) return out;
  const columns: Array<{ col: number; filter: ColumnFilter }> = [];
  for (const [colId, column] of filter.columns) {
    const col = sheet.cols.indexOf(colId);
    if (col >= rect.c1 && col <= rect.c2 && colId !== except) columns.push({ col, filter: column });
  }
  if (columns.length === 0) return out;
  for (let row = rect.r1 + 1; row <= rect.r2; row += 1) {
    for (const { col, filter: column } of columns) {
      if (!columnPasses(column, engine.valueAt(sheet, row, col), engine.textAt(sheet, row, col))) {
        out.add(row);
        break;
      }
    }
  }
  return out;
}

/** The different texts a column shows in the rows the other columns' filters let through, in sorted order. */
export function columnChoices(sheet: Sheet, engine: Engine, filter: SheetFilter, colId: string): Array<{ text: string; count: number }> {
  const rect = filterRect(sheet, filter);
  const col = sheet.cols.indexOf(colId);
  if (!rect || col < 0) return [];
  const hidden = filteredOutRows(sheet, engine, filter, colId);
  const seen = new Map<string, { count: number; value: Scalar }>();
  for (let row = rect.r1 + 1; row <= rect.r2; row += 1) {
    if (hidden.has(row)) continue;
    const text = engine.textAt(sheet, row, col);
    const entry = seen.get(text);
    if (entry) entry.count += 1;
    else seen.set(text, { count: 1, value: engine.valueAt(sheet, row, col) });
  }
  return [...seen.entries()]
    .sort((a, b) => sortOrder(a[1].value, b[1].value))
    .map(([text, entry]) => ({ text, count: entry.count }));
}

// --- Sorting ---

/** Numbers, then text, then TRUE/FALSE, then errors; empty cells always last. */
function sortOrder(a: Scalar, b: Scalar): number {
  const emptyA = a === null || a === '';
  const emptyB = b === null || b === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (isError(a) || isError(b)) return isError(a) === isError(b) ? 0 : isError(a) ? 1 : -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return compareValues(a, b);
}

/**
 * Whether the first row of a range reads as headings: every filled cell in
 * it is text, and either some column holds only numbers, dates or TRUE/FALSE
 * below it, or the first row looks different (bold or filled) from the next.
 */
export function looksLikeHeader(sheet: Sheet, engine: Engine, rect: Rect): boolean {
  if (rect.r2 <= rect.r1) return false;
  let filled = 0;
  let numeric = false;
  for (let col = rect.c1; col <= rect.c2; col += 1) {
    const head = engine.valueAt(sheet, rect.r1, col);
    if (head === null || head === '') continue;
    if (typeof head !== 'string') return false;
    filled += 1;
    let seen = 0;
    let text = false;
    for (let row = rect.r1 + 1; row <= Math.min(rect.r2, rect.r1 + 20); row += 1) {
      const below = engine.valueAt(sheet, row, col);
      if (below === null || below === '') continue;
      seen += 1;
      if (typeof below === 'string') text = true;
    }
    if (seen > 0 && !text) numeric = true;
  }
  if (filled === 0) return false;
  if (numeric) return true;
  const head = sheet.styleAt(rect.r1, rect.c1);
  const next = sheet.styleAt(rect.r1 + 1, rect.c1);
  return Boolean((head.b && !next.b) || (head.bg && head.bg !== next.bg));
}

/** The rows of a range in the order that sorting by one of its columns gives; rows that tie keep their order. */
export function sortedRows(sheet: Sheet, engine: Engine, rect: Rect, keyCol: number, ascending: boolean): number[] {
  const rows = Array.from({ length: rect.r2 - rect.r1 + 1 }, (_unused, index) => rect.r1 + index);
  const keys = new Map(rows.map(row => [row, engine.valueAt(sheet, row, keyCol)]));
  const empty = (value: Scalar) => value === null || value === '';
  return rows.sort((a, b) => {
    const x = keys.get(a) as Scalar;
    const y = keys.get(b) as Scalar;
    // Empty cells go last whichever way the rest is sorted.
    if (empty(x) || empty(y)) return sortOrder(x, y) || a - b;
    return (ascending ? sortOrder(x, y) : sortOrder(y, x)) || a - b;
  });
}

export interface MovedCell {
  raw: CellRaw | undefined;
  style: CellStyle | undefined;
  /** The row the content came from. */
  from: number;
}

/** The content of a range's cells, row by row in a new order of rows. */
export function contentInOrder(sheet: Sheet, rect: Rect, order: number[]): MovedCell[][] {
  return order.map(from => {
    const cells: MovedCell[] = [];
    for (let col = rect.c1; col <= rect.c2; col += 1) {
      cells.push({ raw: sheet.rawAt(from, col), style: sheet.styles.get(cellKey(sheet.rows.ids[from], sheet.cols.ids[col])), from });
    }
    return cells;
  });
}

// --- Finding ---

/** Cells of a sheet whose shown text (or formula, when asked) holds the query, in reading order. */
export function findCells(sheet: Sheet, engine: Engine, query: string, formulaText?: (row: number, col: number) => string): CellPos[] {
  const wanted = query.toLowerCase();
  if (wanted === '') return [];
  const found: CellPos[] = [];
  for (const [key, raw] of sheet.cells.entries()) {
    const at = key.indexOf(':');
    const row = sheet.rows.indexOf(key.slice(0, at));
    const col = sheet.cols.indexOf(key.slice(at + 1));
    if (row < 0 || col < 0) continue;
    const shown = engine.textAt(sheet, row, col).toLowerCase();
    if (shown.includes(wanted) || (formulaText && isFormula(raw) && formulaText(row, col).toLowerCase().includes(wanted))) found.push({ row, col });
  }
  return found.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** Replaces every occurrence of `query` in `text`, whatever its capitals. */
export function replaceIn(text: string, query: string, replacement: string): string {
  if (query === '') return text;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return text.replace(pattern, () => replacement);
}
