/** Cell addresses as people write them: A1, $B$2, C3:D9. Positions count from 0. */

export interface CellPos {
  row: number;
  col: number;
}

/** A rectangle of cells; both corners are inside it. */
export interface Rect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export function columnIndex(name: string): number {
  let index = 0;
  for (const letter of name.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function cellName(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}

export function rectName(rect: Rect): string {
  const first = cellName(rect.r1, rect.c1);
  return rect.r1 === rect.r2 && rect.c1 === rect.c2 ? first : `${first}:${cellName(rect.r2, rect.c2)}`;
}

/** Reads "B7" or "b7:d9"; null when the text is not an address. */
export function parseRectName(text: string): Rect | null {
  const match = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/.exec(text);
  if (!match) return null;
  const c1 = columnIndex(match[1]);
  const r1 = Number(match[2]) - 1;
  const c2 = match[3] ? columnIndex(match[3]) : c1;
  const r2 = match[4] ? Number(match[4]) - 1 : r1;
  if (r1 < 0 || r2 < 0) return null;
  return normalizeRect({ r1, c1, r2, c2 });
}

export function normalizeRect(rect: Rect): Rect {
  return {
    r1: Math.min(rect.r1, rect.r2),
    c1: Math.min(rect.c1, rect.c2),
    r2: Math.max(rect.r1, rect.r2),
    c2: Math.max(rect.c1, rect.c2),
  };
}

export function rectOf(a: CellPos, b: CellPos = a): Rect {
  return normalizeRect({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
}

export function rectContains(rect: Rect, row: number, col: number): boolean {
  return row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2;
}

export function rectRows(rect: Rect): number {
  return rect.r2 - rect.r1 + 1;
}

export function rectCols(rect: Rect): number {
  return rect.c2 - rect.c1 + 1;
}

/** A sheet name as it must be written in front of "!" in a formula. */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replace(/'/g, "''")}'`;
}
