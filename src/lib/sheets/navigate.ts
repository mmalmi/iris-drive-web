/** Moving around the grid with the keyboard. */
import type { CellPos, Rect } from './address';
import type { Sheet } from './model';

/**
 * Where Ctrl/Cmd + an arrow goes: to the end of the run of filled cells, or
 * across the gap to the next filled cell, or to the edge of the sheet.
 */
export function jump(sheet: Sheet, from: CellPos, dRow: number, dCol: number): CellPos {
  const lastRow = sheet.rows.length - 1;
  const lastCol = sheet.cols.length - 1;
  const inside = (row: number, col: number) => row >= 0 && col >= 0 && row <= lastRow && col <= lastCol;
  const filled = (row: number, col: number) => inside(row, col) && !sheet.isEmpty(row, col);
  let { row, col } = from;
  if (!inside(row + dRow, col + dCol)) return from;

  if (filled(row, col) && filled(row + dRow, col + dCol)) {
    while (filled(row + dRow, col + dCol)) {
      row += dRow;
      col += dCol;
    }
    return { row, col };
  }
  // Across empty cells. Only the filled cells need looking at, however large the sheet.
  const used = sheet.usedRect();
  const edge = { row: dRow < 0 ? 0 : dRow > 0 ? lastRow : row, col: dCol < 0 ? 0 : dCol > 0 ? lastCol : col };
  if (!used) return edge;
  row += dRow;
  col += dCol;
  while (inside(row, col) && row <= Math.max(used.r2, from.row) && col <= Math.max(used.c2, from.col)) {
    if (filled(row, col)) return { row, col };
    row += dRow;
    col += dCol;
  }
  return edge;
}

/** The next cell inside a selection, wrapping at its edges; for Tab and Enter. */
export function stepInside(rect: Rect, from: CellPos, dRow: number, dCol: number): CellPos {
  let { row, col } = from;
  if (dCol !== 0) {
    col += dCol;
    if (col > rect.c2) {
      col = rect.c1;
      row = row >= rect.r2 ? rect.r1 : row + 1;
    } else if (col < rect.c1) {
      col = rect.c2;
      row = row <= rect.r1 ? rect.r2 : row - 1;
    }
  } else {
    row += dRow;
    if (row > rect.r2) {
      row = rect.r1;
      col = col >= rect.c2 ? rect.c1 : col + 1;
    } else if (row < rect.r1) {
      row = rect.r2;
      col = col <= rect.c1 ? rect.c2 : col - 1;
    }
  }
  return { row, col };
}

/** The last filled column in a row, or 0. */
export function lastFilledCol(sheet: Sheet, row: number): number {
  const used = sheet.usedRect();
  if (!used) return 0;
  for (let col = used.c2; col > 0; col -= 1) if (!sheet.isEmpty(row, col)) return col;
  return 0;
}
