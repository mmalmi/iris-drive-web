/** Sorting, filtering, finding and hiding: the actions on a sheet's data as a whole. */
import { rectCols, rectRows, type Rect } from './address';
import type { SheetController } from './controller.svelte';
import { editTextAt, inputToStored } from './edit';
import {
  contentInOrder,
  filterRect,
  looksLikeHeader,
  replaceIn,
  sortedRows,
  type ColumnFilter,
} from './filter';
import { cellKey, isFormula, type CellRaw } from './model';
import { transplant } from './refs';

/** The block of filled cells around the active cell, or the whole filled area when the cell is empty. */
function dataRegion(ctl: SheetController): Rect | null {
  const sheet = ctl.sheet;
  const used = sheet.usedRect();
  if (!used) return null;
  const { row, col } = ctl.active;
  if (sheet.isEmpty(row, col)) return used;
  const rect = { r1: row, c1: col, r2: row, c2: col };
  const filled = (r1: number, c1: number, r2: number, c2: number) => {
    for (let r = r1; r <= r2; r += 1) for (let c = c1; c <= c2; c += 1) if (!sheet.isEmpty(r, c)) return true;
    return false;
  };
  // Grow while a neighbouring row or column still holds something.
  for (let grown = true; grown;) {
    grown = false;
    if (rect.r1 > 0 && filled(rect.r1 - 1, rect.c1, rect.r1 - 1, rect.c2)) { rect.r1 -= 1; grown = true; }
    if (rect.r2 < used.r2 && filled(rect.r2 + 1, rect.c1, rect.r2 + 1, rect.c2)) { rect.r2 += 1; grown = true; }
    if (rect.c1 > 0 && filled(rect.r1, rect.c1 - 1, rect.r2, rect.c1 - 1)) { rect.c1 -= 1; grown = true; }
    if (rect.c2 < used.c2 && filled(rect.r1, rect.c2 + 1, rect.r2, rect.c2 + 1)) { rect.c2 += 1; grown = true; }
  }
  return rect;
}

/** What sorting would act on now: the selected range, or the table around the active cell. */
export function sortTarget(ctl: SheetController): { rect: Rect; header: boolean; keyCol: number } | null {
  const sheet = ctl.sheet;
  const used = sheet.usedRect();
  if (!used) return null;
  const selection = ctl.selection;
  let rect: Rect | null;
  if (ctl.scope === 'cols' || ctl.scope === 'all') rect = { r1: 0, c1: 0, r2: used.r2, c2: used.c2 };
  else if (rectRows(selection) > 1) rect = { ...selection, r2: Math.min(selection.r2, Math.max(used.r2, selection.r1)) };
  else rect = dataRegion(ctl);
  if (!rect || rect.r2 <= rect.r1) return null;
  const keyCol = Math.max(rect.c1, Math.min(ctl.active.col, rect.c2));
  return { rect, header: looksLikeHeader(sheet, ctl.engine, rect), keyCol };
}

/**
 * Sorts the rows of a range by one of its columns. The cells' content moves;
 * formulas among them are adjusted as when they are copied to their new row.
 */
export function sortRange(ctl: SheetController, rect: Rect, keyCol: number, ascending: boolean): void {
  const sheet = ctl.sheet;
  const order = sortedRows(sheet, ctl.engine, rect, keyCol, ascending);
  if (order.every((row, index) => row === rect.r1 + index)) return;
  const content = contentInOrder(sheet, rect, order);
  ctl.book.transact(() => {
    content.forEach((cells, index) => {
      const row = rect.r1 + index;
      const rowId = sheet.rows.ids[row];
      cells.forEach((cell, offset) => {
        if (cell.from === row) return;
        const key = cellKey(rowId, sheet.cols.ids[rect.c1 + offset]);
        let raw: CellRaw | undefined = cell.raw;
        if (isFormula(raw)) raw = transplant(raw, ctl.book, sheet, sheet, row - cell.from, 0);
        if (raw === undefined) sheet.cells.delete(key);
        else if (sheet.cells.get(key) !== raw) sheet.cells.set(key, raw);
        if (cell.style) sheet.styles.set(key, cell.style);
        else if (sheet.styles.has(key)) sheet.styles.delete(key);
      });
    });
  });
  // Someone who may only read has now rearranged their own copy, which is never stored.
  if (!ctl.canEdit) ctl.localOnly = true;
}

/** Sorts the selected range or the table around the active cell by the active cell's column. */
export function sortSelection(ctl: SheetController, ascending: boolean, header?: boolean): void {
  const target = sortTarget(ctl);
  if (!target) {
    ctl.say('There is nothing to sort here.');
    return;
  }
  const { rect, keyCol } = target;
  const skip = (header ?? target.header) ? 1 : 0;
  if (rect.r2 - rect.r1 - skip < 1) return;
  sortRange(ctl, { ...rect, r1: rect.r1 + skip }, keyCol, ascending);
  ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 }, { row: rect.r1 + skip, col: keyCol });
}

// --- Filter ---

/** Turns the filter on for the selected range or the table around the active cell, or off again. */
export function toggleFilter(ctl: SheetController): void {
  if (ctl.filter) {
    ctl.setFilter(null);
    return;
  }
  const sheet = ctl.sheet;
  const selection = ctl.selection;
  const rect = rectRows(selection) > 1 || rectCols(selection) > 1 ? selection : dataRegion(ctl);
  if (!rect || !sheet.usedRect()) {
    ctl.say('There is nothing to filter yet.');
    return;
  }
  ctl.setFilter({
    headerRowId: sheet.rows.ids[rect.r1],
    firstColId: sheet.cols.ids[rect.c1],
    lastColId: sheet.cols.ids[rect.c2],
    columns: new Map(),
  });
}

/** Changes what one column of the filter lets through; null lets everything through again. */
export function setColumnFilter(ctl: SheetController, colId: string, column: ColumnFilter | null): void {
  const filter = ctl.filter;
  if (!filter) return;
  const columns = new Map(filter.columns);
  if (column && (column.excluded.size > 0 || column.condition)) columns.set(colId, column);
  else columns.delete(colId);
  ctl.setFilter({ ...filter, columns });
  // The active cell may have dropped out of view.
  const rect = filterRect(ctl.sheet, filter);
  if (rect && ctl.visibility.rows.has(ctl.active.row)) ctl.setSelection({ row: rect.r1, col: ctl.active.col });
}

/** Sorts the rows under the filter's header by one of its columns. */
export function sortFiltered(ctl: SheetController, colId: string, ascending: boolean): void {
  const filter = ctl.filter;
  const rect = filter && filterRect(ctl.sheet, filter);
  const col = ctl.sheet.cols.indexOf(colId);
  if (!rect || col < 0 || rect.r2 <= rect.r1) return;
  sortRange(ctl, { ...rect, r1: rect.r1 + 1 }, col, ascending);
}

// --- Hiding ---

export function hideSelected(ctl: SheetController, axis: 'row' | 'col'): void {
  if (!ctl.canEdit) return;
  const rect = ctl.selection;
  const [from, to] = axis === 'row' ? [rect.r1, rect.r2] : [rect.c1, rect.c2];
  ctl.sheet.setHidden(axis, from, to, true);
  // Step off the hidden rows onto the nearest one still in view.
  const hidden = ctl.sheet.hidden(axis);
  const count = axis === 'row' ? ctl.sheet.rows.length : ctl.sheet.cols.length;
  let next = to + 1;
  while (next < count && hidden.has(next)) next += 1;
  if (next >= count) for (next = from - 1; next > 0 && hidden.has(next); next -= 1);
  if (axis === 'row') ctl.setSelection({ row: Math.max(0, next), col: ctl.active.col });
  else ctl.setSelection({ row: ctl.active.row, col: Math.max(0, next) });
}

/** Hidden rows or columns inside the selection or right beside it, as the range to show again. */
export function hiddenNear(ctl: SheetController, axis: 'row' | 'col'): [number, number] | null {
  const hidden = ctl.sheet.hidden(axis);
  if (hidden.size === 0) return null;
  const rect = ctl.selection;
  let [from, to] = axis === 'row' ? [rect.r1, rect.r2] : [rect.c1, rect.c2];
  while (hidden.has(from - 1)) from -= 1;
  while (hidden.has(to + 1)) to += 1;
  for (let index = from; index <= to; index += 1) if (hidden.has(index)) return [from, to];
  return null;
}

export function showHidden(ctl: SheetController, axis: 'row' | 'col'): void {
  const range = hiddenNear(ctl, axis);
  if (ctl.canEdit && range) ctl.sheet.setHidden(axis, range[0], range[1], false);
}

// --- Find and replace ---

/** Selects the next (or previous) cell that holds what is searched for. */
export function findNext(ctl: SheetController, backwards = false): void {
  const matches = ctl.findMatches;
  if (matches.length === 0) return;
  const { row, col } = ctl.active;
  const after = (cell: { row: number; col: number }) => cell.row > row || (cell.row === row && cell.col > col);
  const before = (cell: { row: number; col: number }) => cell.row < row || (cell.row === row && cell.col < col);
  const next = backwards
    ? [...matches].reverse().find(before) ?? matches[matches.length - 1]
    : matches.find(after) ?? matches[0];
  ctl.setSelection(next);
  ctl.reveal(next.row, next.col);
}

/** Which of the matches the active cell is, counting from 1; 0 when it is none of them. */
export function findPosition(ctl: SheetController): number {
  const { row, col } = ctl.active;
  return ctl.findMatches.findIndex(cell => cell.row === row && cell.col === col) + 1;
}

function replaceInCell(ctl: SheetController, row: number, col: number, query: string, replacement: string): boolean {
  const sheet = ctl.sheet;
  const text = editTextAt(ctl.book, sheet, row, col);
  const next = replaceIn(text, query, replacement);
  if (next === text) return false;
  const style = sheet.styleAt(row, col);
  const stored = inputToStored(next, ctl.book, sheet, style.nf);
  sheet.setRaw(row, col, stored.raw);
  if (stored.format && !style.nf) sheet.patchStyle({ r1: row, c1: col, r2: row, c2: col }, { nf: stored.format });
  return true;
}

/** Replaces in the active cell when it is a match, then goes to the next one. */
export function replaceOne(ctl: SheetController): void {
  const find = ctl.find;
  if (!ctl.canEdit || !find || find.replace === null) return;
  if (findPosition(ctl) > 0) replaceInCell(ctl, ctl.active.row, ctl.active.col, find.query, find.replace);
  findNext(ctl);
}

export function replaceAll(ctl: SheetController): void {
  const find = ctl.find;
  if (!ctl.canEdit || !find || find.replace === null) return;
  const { query, replace } = find;
  let changed = 0;
  ctl.book.transact(() => {
    for (const cell of ctl.findMatches) if (replaceInCell(ctl, cell.row, cell.col, query, replace)) changed += 1;
  });
  ctl.say(changed === 0 ? 'Nothing to replace.' : changed === 1 ? 'Replaced in 1 cell.' : `Replaced in ${changed} cells.`);
}
