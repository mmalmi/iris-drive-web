/**
 * Results of several cells. A formula such as =UNIQUE(A2:A9) sits in one
 * cell and its values fill the empty cells to the right and below, as in
 * Google Sheets. The engine calculates the formula; this lays the result
 * out and says which cells' values changed. The values are worked out on
 * each device and never stored.
 */
import { cellName, rectContains, type Rect } from './address';
import type { RefSpec } from './formula';
import { cellKey, type Book, type Sheet } from './model';
import { resolveRef } from './refs';
import { SheetError, err, isError, type Matrix, type Scalar } from './values';

/** The most cells one formula's result may fill. */
export const MOST_SPILLED = 500_000;

/** A result as laid out, from its formula's own cell. */
export interface Spill {
  row: number;
  col: number;
  values: Scalar[][];
  formats: Array<string | undefined>;
}

/** What the layout needs of a formula whose result is several cells. */
export interface SpillSource {
  readonly sheet: Sheet;
  readonly key: string;
  readonly rowId: string;
  readonly colId: string;
  readonly refs: RefSpec[];
  /** Every value of the result, row by row. */
  array: Scalar[][] | null;
  /** The number format each column of the result implies. */
  arrayFormats: Array<string | undefined> | null;
  /** What the formula's own cell shows: the first value, or why the result is not laid out. */
  value: Scalar;
  /** Where the result was last laid out, when it was. */
  spill: Spill | null;
}

type Grid<T> = Array<Array<T | undefined> | undefined>;

export function sameValue(a: Scalar, b: Scalar): boolean {
  if (isError(a) || isError(b)) return isError(a) && isError(b) && a.code === b.code && a.message === b.message;
  return a === b;
}

/** A result's values row by row, numbers that cannot be shown turned into #NUM!. */
export function materialize(result: Matrix): Scalar[][] {
  const rows: Scalar[][] = [];
  for (let r = 0; r < result.rows; r += 1) {
    const row: Scalar[] = [];
    for (let c = 0; c < result.cols; c += 1) {
      const value = result.get(r, c);
      row.push(typeof value === 'number' && !Number.isFinite(value) ? err('#NUM!', 'The result is not a number that can be shown') : value);
    }
    rows.push(row);
  }
  return rows;
}

/** #REF! when a result of `rows` by `cols` from a cell would not fit on the sheet. */
export function pastEdge(sheet: Sheet, row: number, col: number, rows: number, cols: number): SheetError | null {
  const moreRows = row + rows - sheet.rows.length;
  const moreCols = col + cols - sheet.cols.length;
  if (moreRows <= 0 && moreCols <= 0) return null;
  const wanted = [moreRows > 0 ? `${moreRows} more ${moreRows === 1 ? 'row' : 'rows'}` : '', moreCols > 0 ? `${moreCols} more ${moreCols === 1 ? 'column' : 'columns'}` : ''];
  return err('#REF!', `Array result was not expanded because it would go past the edge of the sheet. Add ${wanted.filter(Boolean).join(' and ')}.`);
}

/**
 * Why a result of `rows` by `cols` cannot fill the cells from its formula's
 * own: the edge of the sheet, a cell in the way, or cells the formula reads.
 * `taken` holds the cells other results already fill.
 */
export function spillProblem<T>(book: Book, source: SpillSource, row: number, col: number, rows: number, cols: number, taken?: Grid<T>): SheetError | null {
  const { sheet } = source;
  const edge = pastEdge(sheet, row, col, rows, cols);
  if (edge) return edge;
  const area: Rect = { r1: row, c1: col, r2: row + rows - 1, c2: col + cols - 1 };
  // The first cell in the way, row by row.
  let blocked: { row: number; col: number } | null = null;
  const block = (r: number, c: number) => {
    if (r === row && c === col) return;
    if (!blocked || r < blocked.row || (r === blocked.row && c < blocked.col)) blocked = { row: r, col: c };
  };
  if (rows * cols <= sheet.cells.size * 2) {
    for (let r = row; r <= area.r2 && !blocked; r += 1) {
      for (let c = col; c <= area.c2 && !blocked; c += 1) {
        if (sheet.cells.has(cellKey(sheet.rows.ids[r], sheet.cols.ids[c]))) block(r, c);
      }
    }
  } else {
    for (const key of sheet.cells.keys()) {
      const at = key.indexOf(':');
      const r = sheet.rows.indexOf(key.slice(0, at));
      const c = sheet.cols.indexOf(key.slice(at + 1));
      if (r >= 0 && c >= 0 && rectContains(area, r, c)) block(r, c);
    }
  }
  if (taken) {
    for (let r = row; r <= area.r2; r += 1) {
      const line = taken[r];
      if (line) for (let c = col; c <= area.c2; c += 1) if (line[c]) block(r, c);
    }
  }
  const cell = blocked as { row: number; col: number } | null;
  if (cell) return err('#REF!', `Array result was not expanded because it would overwrite data in ${cellName(cell.row, cell.col)}.`);
  for (const ref of source.refs) {
    const target = resolveRef(ref, book, sheet);
    if (target instanceof SheetError || target.sheet !== sheet) continue;
    const r2 = Math.min(target.rect.r2, area.r2);
    const c2 = Math.min(target.rect.c2, area.c2);
    const overlaps = Math.max(target.rect.r1, area.r1) <= r2 && Math.max(target.rect.c1, area.c1) <= c2;
    if (overlaps && (r2 > row || c2 > col)) return err('#CYCLE!', 'The result would fill cells this formula reads');
  }
  return null;
}

/** Where every result of several cells is laid out. */
export class Spills<T extends SpillSource> {
  /** By sheet, row and column: the formula whose result fills the cell. Formulas' own cells are not included. */
  private grids = new Map<string, Grid<T>>();

  get empty(): boolean {
    return this.grids.size === 0;
  }

  /** The formula whose result fills a cell, if one does. */
  sourceAt(sheet: Sheet, row: number, col: number): T | undefined {
    return this.grids.get(sheet.id)?.[row]?.[col];
  }

  /**
   * Lays out every result again. Results are taken in the same order on
   * every device, by sheet, row and column, so that where two would cover
   * the same cell the same one shows #REF!. `changed` hears of each formula
   * whose own cell now shows something else, and of each cell whose value
   * changed, so that the formulas reading them calculate again.
   */
  place(book: Book, formulas: Iterable<T>, changed: (sheet: Sheet, row: number, col: number) => void): void {
    const sheetOrder = new Map(book.sheets.map((info, index) => [info.id, index]));
    const sources: Array<{ source: T; order: number; row: number; col: number }> = [];
    for (const source of formulas) {
      const order = sheetOrder.get(source.sheet.id);
      const row = source.sheet.rows.indexOf(source.rowId);
      const col = source.sheet.cols.indexOf(source.colId);
      if (order !== undefined && row >= 0 && col >= 0 && source.array) sources.push({ source, order, row, col });
    }
    sources.sort((a, b) => a.order - b.order || a.row - b.row || a.col - b.col);

    const before = this.grids;
    const after = new Map<string, Grid<T>>();
    const placed = new Map<T, Spill>();
    for (const { source, row, col } of sources) {
      const values = source.array as Scalar[][];
      let grid = after.get(source.sheet.id);
      if (!grid) after.set(source.sheet.id, grid = []);
      const problem = spillProblem(book, source, row, col, values.length, values[0].length, grid);
      const value = problem ?? values[0][0];
      if (!sameValue(value, source.value)) {
        source.value = value;
        changed(source.sheet, row, col);
      }
      if (problem) continue;
      placed.set(source, { row, col, values, formats: source.arrayFormats ?? [] });
      for (let r = 0; r < values.length; r += 1) {
        const line = (grid[row + r] ??= []);
        for (let c = 0; c < values[0].length; c += 1) if (r > 0 || c > 0) line[col + c] = source;
      }
    }

    const valueIn = (spill: Spill | null | undefined, row: number, col: number): Scalar => (spill ? spill.values[row - spill.row]?.[col - spill.col] ?? null : null);
    const previous = new Set<T>();
    for (const [sheetId, grid] of before) {
      const now = after.get(sheetId);
      const live = sheetOrder.has(sheetId);
      grid.forEach((line, row) => line?.forEach((source, col) => {
        if (!source) return;
        previous.add(source);
        const next = now?.[row]?.[col];
        if (live && !sameValue(valueIn(source.spill, row, col), next ? valueIn(placed.get(next), row, col) : null)) changed(book.sheet(sheetId), row, col);
      }));
    }
    for (const [sheetId, grid] of after) {
      const then = before.get(sheetId);
      grid.forEach((line, row) => line?.forEach((source, col) => {
        // Cells that were filled before are compared above; empty ones were empty.
        if (source && !then?.[row]?.[col] && valueIn(placed.get(source), row, col) !== null) changed(book.sheet(sheetId), row, col);
      }));
    }
    for (const source of previous) source.spill = null;
    for (const [source, spill] of placed) source.spill = spill;
    this.grids = after;
  }
}
