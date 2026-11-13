/**
 * Tables on slides. A table is an element like any other, with its frame;
 * inside it keeps
 *
 *   rows    Y.Map  <row id> → Y.Map { pos: position key, size?: share of the height }
 *   cols    Y.Map  <column id> → Y.Map { pos: position key, size?: share of the width }
 *   cells   Y.Map  "<row id>:<column id>" → Y.Map { content: Y.XmlFragment, fill?: colour }
 *   header  true when the first row is drawn as a heading
 *
 * Rows and columns are found by id and ordered by a key each carries, like
 * slides, so two people adding rows at once both keep theirs, and one
 * moving a column while another types in it loses nothing. Every cell has
 * its own text, so people typing in different cells never touch the same
 * text. A cell missing for a row and a column that were added at the same
 * moment on two devices is drawn empty and made when someone types in it.
 */
import * as Y from 'yjs';
import { comparePositions, keyBetween, keysBetween, readKey } from './order';
import { richTextNodesFromJson, richTextToJson, type RichTextJson } from './richTextData';

export interface TableLine {
  id: string;
  pos: string;
  /** Its share of the table's width or height, relative to the others. */
  size: number;
}

export interface TableCell {
  content: Y.XmlFragment | null;
  fill?: string;
}

export interface TableData {
  /** Top to bottom. */
  rows: TableLine[];
  /** Left to right. */
  cols: TableLine[];
  cells: Map<string, TableCell>;
  /** Changes whenever anything but the words in the cells does, to tell when the grid must be drawn again. */
  signature: string;
}

export interface TableJson {
  rows: TableLine[];
  cols: TableLine[];
  cells: Record<string, { content: RichTextJson; fill?: string }>;
}

export const MAX_TABLE_LINES = 40;

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

function readLines(map: unknown): TableLine[] {
  if (!(map instanceof Y.Map)) return [];
  const lines: TableLine[] = [];
  for (const [id, line] of map as Y.Map<unknown>) {
    if (!(line instanceof Y.Map)) continue;
    const size = line.get('size');
    lines.push({ id, pos: readKey(line.get('pos')), size: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 1 });
  }
  return lines.sort(comparePositions);
}

function colourOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length < 40 ? value : undefined;
}

/** Reads the grid of a table element, or null when it has none. */
export function readTable(map: Y.Map<unknown>): TableData | null {
  const rows = readLines(map.get('rows'));
  const cols = readLines(map.get('cols'));
  if (rows.length === 0 || cols.length === 0) return null;
  const stored = map.get('cells');
  const cells = new Map<string, TableCell>();
  const fills: string[] = [];
  for (const row of rows) {
    for (const col of cols) {
      const key = cellKey(row.id, col.id);
      const cell = stored instanceof Y.Map ? stored.get(key) : undefined;
      if (!(cell instanceof Y.Map)) continue;
      const content = cell.get('content');
      const fill = colourOf(cell.get('fill'));
      cells.set(key, { content: content instanceof Y.XmlFragment ? content : null, ...(fill ? { fill } : {}) });
      if (fill) fills.push(`${key}=${fill}`);
    }
  }
  const lines = (list: TableLine[]) => list.map(line => `${line.id}@${line.pos}*${line.size}`).join(',');
  return { rows, cols, cells, signature: `${lines(rows)}|${lines(cols)}|${[...cells.keys()].join(',')}|${fills.join(',')}` };
}

function newLineId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = '';
  for (const byte of bytes) id += (byte % 36).toString(36);
  return id;
}

/** The plain data of a new, empty table. */
export function newTable(rowCount: number, colCount: number): TableJson {
  const rows = Math.min(MAX_TABLE_LINES, Math.max(1, Math.round(rowCount)));
  const cols = Math.min(MAX_TABLE_LINES, Math.max(1, Math.round(colCount)));
  const rowKeys = keysBetween(null, null, rows);
  const colKeys = keysBetween(null, null, cols);
  const table: TableJson = {
    rows: rowKeys.map(pos => ({ id: newLineId(), pos, size: 1 })),
    cols: colKeys.map(pos => ({ id: newLineId(), pos, size: 1 })),
    cells: {},
  };
  for (const row of table.rows) {
    for (const col of table.cols) table.cells[cellKey(row.id, col.id)] = { content: [] };
  }
  return table;
}

/** A table as plain data, to copy it. */
export function tableToJson(table: TableData): TableJson {
  const cells: TableJson['cells'] = {};
  for (const [key, cell] of table.cells) cells[key] = { content: richTextToJson(cell.content), ...(cell.fill ? { fill: cell.fill } : {}) };
  return { rows: table.rows.map(line => ({ ...line })), cols: table.cols.map(line => ({ ...line })), cells };
}

function lineMap(line: TableLine): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('pos', line.pos);
  if (line.size !== 1) map.set('size', line.size);
  return map;
}

function cellMap(content: RichTextJson | null, fill?: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  const fragment = new Y.XmlFragment();
  map.set('content', fragment);
  const nodes = content ? richTextNodesFromJson(content) : [];
  if (nodes.length) fragment.insert(0, nodes);
  if (fill) map.set('fill', fill);
  return map;
}

/** Writes a table given as plain data into a new table element. Anything that does not look like one is left out. */
export function writeTable(map: Y.Map<unknown>, json: unknown): void {
  const data = json as Partial<TableJson> | null;
  const valid = (lines: unknown): TableLine[] => (Array.isArray(lines) ? lines : [])
    .filter((line): line is TableLine => !!line && typeof line.id === 'string' && /^[a-z0-9]{1,16}$/.test(line.id) && typeof line.pos === 'string')
    .slice(0, MAX_TABLE_LINES);
  const rows = valid(data?.rows);
  const cols = valid(data?.cols);
  const fallback = newTable(rows.length || 2, cols.length || 2);
  const useRows = rows.length ? rows : fallback.rows;
  const useCols = cols.length ? cols : fallback.cols;
  const rowsMap = new Y.Map<unknown>();
  const colsMap = new Y.Map<unknown>();
  const cellsMap = new Y.Map<unknown>();
  map.set('rows', rowsMap);
  map.set('cols', colsMap);
  map.set('cells', cellsMap);
  for (const row of useRows) rowsMap.set(row.id, lineMap({ ...row, size: typeof row.size === 'number' && row.size > 0 ? row.size : 1 }));
  for (const col of useCols) colsMap.set(col.id, lineMap({ ...col, size: typeof col.size === 'number' && col.size > 0 ? col.size : 1 }));
  const cells = data?.cells && typeof data.cells === 'object' ? data.cells : {};
  for (const row of useRows) {
    for (const col of useCols) {
      const key = cellKey(row.id, col.id);
      const cell = (cells as Record<string, { content?: unknown; fill?: unknown }>)[key];
      cellsMap.set(key, cellMap((cell?.content as RichTextJson | undefined) ?? null, colourOf(cell?.fill)));
    }
  }
}

function lines(map: Y.Map<unknown>, kind: 'rows' | 'cols'): Y.Map<Y.Map<unknown>> | null {
  const value = map.get(kind);
  return value instanceof Y.Map ? value as Y.Map<Y.Map<unknown>> : null;
}

function cells(map: Y.Map<unknown>): Y.Map<Y.Map<unknown>> | null {
  const value = map.get('cells');
  return value instanceof Y.Map ? value as Y.Map<Y.Map<unknown>> : null;
}

/**
 * Adds a row or column at `index` among those there are now (at the end when
 * it is their number) and gives it its cells. Returns its id.
 */
export function insertLine(map: Y.Map<unknown>, kind: 'rows' | 'cols', index: number): string | null {
  const table = readTable(map);
  const target = lines(map, kind);
  const cellStore = cells(map);
  if (!table || !target || !cellStore) return null;
  const list = kind === 'rows' ? table.rows : table.cols;
  if (list.length >= MAX_TABLE_LINES) return null;
  const at = Math.min(list.length, Math.max(0, index));
  // A new line is as big as the one beside it.
  const beside = list[at] ?? list[at - 1];
  const line: TableLine = { id: newLineId(), pos: keyBetween(list[at - 1]?.pos, list[at]?.pos), size: beside?.size ?? 1 };
  target.set(line.id, lineMap(line));
  for (const other of kind === 'rows' ? table.cols : table.rows) {
    const key = kind === 'rows' ? cellKey(line.id, other.id) : cellKey(other.id, line.id);
    cellStore.set(key, cellMap(null));
  }
  return line.id;
}

/** Takes a row or column away with its cells. */
export function removeLine(map: Y.Map<unknown>, kind: 'rows' | 'cols', id: string): void {
  const target = lines(map, kind);
  const cellStore = cells(map);
  if (!target || !cellStore) return;
  target.delete(id);
  for (const key of [...cellStore.keys()]) {
    const [row, col] = key.split(':');
    if ((kind === 'rows' ? row : col) === id) cellStore.delete(key);
  }
}

/** The text of a cell, made when the cell is missing. */
export function ensureCell(map: Y.Map<unknown>, key: string): Y.XmlFragment | null {
  const cellStore = cells(map);
  if (!cellStore) return null;
  const existing = cellStore.get(key);
  const content = existing?.get('content');
  if (content instanceof Y.XmlFragment) return content;
  const made = cellMap(null);
  if (existing) existing.set('content', made.get('content'));
  else cellStore.set(key, made);
  return (cellStore.get(key)?.get('content') as Y.XmlFragment | undefined) ?? null;
}

export function setCellFill(map: Y.Map<unknown>, keys: string[], fill: string | null): void {
  const cellStore = cells(map);
  if (!cellStore) return;
  for (const key of keys) {
    let cell = cellStore.get(key);
    if (!cell) {
      if (!fill) continue;
      cell = cellMap(null);
      cellStore.set(key, cell);
    }
    if (fill) cell.set('fill', fill);
    else if (cell.has('fill')) cell.delete('fill');
  }
}

/** Every text of a table, cell by cell, row by row. */
export function tableFragments(map: Y.Map<unknown>): Y.XmlFragment[] {
  const table = readTable(map);
  if (!table) return [];
  const result: Y.XmlFragment[] = [];
  for (const row of table.rows) {
    for (const col of table.cols) {
      const content = table.cells.get(cellKey(row.id, col.id))?.content;
      if (content) result.push(content);
    }
  }
  return result;
}

/** The cell after (or before, when `back`) the given one, row by row; null past either end. */
export function stepCell(table: TableData, key: string, back: boolean): string | null {
  const order = table.rows.flatMap(row => table.cols.map(col => cellKey(row.id, col.id)));
  const at = order.indexOf(key);
  if (at < 0) return order[0] ?? null;
  return order[at + (back ? -1 : 1)] ?? null;
}

/** Where a cell is: its row and column, by place. */
export function cellPlace(table: TableData, key: string): { row: number; col: number } | null {
  const [rowId, colId] = key.split(':');
  const row = table.rows.findIndex(line => line.id === rowId);
  const col = table.cols.findIndex(line => line.id === colId);
  return row >= 0 && col >= 0 ? { row, col } : null;
}
