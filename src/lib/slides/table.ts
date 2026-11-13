/**
 * Tables on slides. A table is an element like any other, with its frame;
 * inside it keeps
 *
 *   rows    Y.Map  <row id> → Y.Map { pos: position key, size?: share of the height }
 *   cols    Y.Map  <column id> → Y.Map { pos: position key, size?: share of the width }
 *   cells   Y.Map  "<row id>:<column id>" → Y.Map
 *             content      Y.XmlFragment, its text
 *             fill?        colour
 *             merge?       "<row id>:<column id>" of the bottom-right cell of the block this
 *                          cell is the top-left of, when cells are merged (format version 3)
 *             bt bb bl br  its own top, bottom, left and right line: "none", or
 *                          "<width> <colour>"; the table's line when absent (version 3)
 *   header  true when the first row is drawn as a heading
 *
 * Rows and columns are found by id and ordered by a key each carries, like
 * slides, so two people adding rows at once both keep theirs, and one
 * moving a column while another types in it loses nothing. Every cell has
 * its own text, so people typing in different cells never touch the same
 * text. A cell missing for a row and a column that were added at the same
 * moment on two devices is drawn empty and made when someone types in it.
 *
 * A merged block is named by its two corners, so rows and columns added
 * inside it on another device simply join it. Blocks that came to overlap
 * because two people merged at once are settled the same way everywhere:
 * the first block, row by row, wins and the other is drawn unmerged. A line
 * given to an edge is written on both cells that share the edge.
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

export type Side = 't' | 'b' | 'l' | 'r';

/** A line along one edge of a cell. */
export interface CellBorder {
  width: number;
  colour: string;
}

export interface TableCell {
  content: Y.XmlFragment | null;
  fill?: string;
  /** Edges with a line of their own; 'none' takes the table's line away there. */
  borders?: Partial<Record<Side, CellBorder | 'none'>>;
}

/** A block of merged cells: how many rows and columns it covers from its top-left cell. */
export interface MergedBlock {
  rows: number;
  cols: number;
}

/** A rectangle of cells, by place: first and last row and column, inclusive. */
export interface CellRect {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface TableData {
  /** Top to bottom. */
  rows: TableLine[];
  /** Left to right. */
  cols: TableLine[];
  cells: Map<string, TableCell>;
  /** Merged blocks, by the key of their top-left cell. */
  merges: Map<string, MergedBlock>;
  /** Cells hidden under a merged block, and the top-left cell of that block. */
  covered: Map<string, string>;
  /** Changes whenever anything but the words in the cells does, to tell when the grid must be drawn again. */
  signature: string;
}

export interface CellJson {
  content: RichTextJson;
  fill?: string;
  merge?: string;
  bt?: string;
  bb?: string;
  bl?: string;
  br?: string;
}

export interface TableJson {
  rows: TableLine[];
  cols: TableLine[];
  cells: Record<string, CellJson>;
}

const MAX_TABLE_LINES = 40;
const SIDES: Side[] = ['t', 'b', 'l', 'r'];

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

function readBorder(value: unknown): CellBorder | 'none' | undefined {
  if (value === 'none') return 'none';
  if (typeof value !== 'string' || value.length > 48) return undefined;
  const match = /^(\d+(?:\.\d+)?) (\S+)$/.exec(value);
  if (!match) return undefined;
  const width = Number(match[1]);
  return width > 0 && width <= 40 ? { width, colour: match[2]! } : undefined;
}

/** A line as it is stored. */
export function borderValue(border: CellBorder | 'none'): string {
  return border === 'none' ? 'none' : `${Math.round(border.width * 10) / 10} ${border.colour}`;
}

/** Reads the grid of a table element, or null when it has none. */
export function readTable(map: Y.Map<unknown>): TableData | null {
  const rows = readLines(map.get('rows'));
  const cols = readLines(map.get('cols'));
  if (rows.length === 0 || cols.length === 0) return null;
  const stored = map.get('cells');
  const cells = new Map<string, TableCell>();
  const looks: string[] = [];
  const wanted: Array<{ key: string; end: string }> = [];
  for (const row of rows) {
    for (const col of cols) {
      const key = cellKey(row.id, col.id);
      const cell = stored instanceof Y.Map ? stored.get(key) : undefined;
      if (!(cell instanceof Y.Map)) continue;
      const content = cell.get('content');
      const fill = colourOf(cell.get('fill'));
      const read: TableCell = { content: content instanceof Y.XmlFragment ? content : null };
      if (fill) read.fill = fill;
      for (const side of SIDES) {
        const border = readBorder(cell.get(`b${side}`));
        if (border) (read.borders ??= {})[side] = border;
      }
      cells.set(key, read);
      const merge = cell.get('merge');
      if (typeof merge === 'string') wanted.push({ key, end: merge });
      if (fill || read.borders || typeof merge === 'string') {
        looks.push(`${key}=${fill ?? ''}/${typeof merge === 'string' ? merge : ''}/${read.borders ? JSON.stringify(read.borders) : ''}`);
      }
    }
  }
  const merges = new Map<string, MergedBlock>();
  const covered = new Map<string, string>();
  const rowIndex = new Map(rows.map((row, index) => [row.id, index]));
  const colIndex = new Map(cols.map((col, index) => [col.id, index]));
  // Row by row, so that of two blocks that overlap the same one wins on every device.
  for (const { key, end } of wanted) {
    const [rowId, colId] = key.split(':');
    const [endRow, endCol] = end.split(':');
    const r0 = rowIndex.get(rowId!);
    const c0 = colIndex.get(colId!);
    const r1 = rowIndex.get(endRow ?? '');
    const c1 = colIndex.get(endCol ?? '');
    if (r0 === undefined || c0 === undefined || r1 === undefined || c1 === undefined || r1 < r0 || c1 < c0) continue;
    if (r1 === r0 && c1 === c0) continue;
    const inside: string[] = [];
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) inside.push(cellKey(rows[r]!.id, cols[c]!.id));
    if (inside.some(cell => merges.has(cell) || covered.has(cell))) continue;
    merges.set(key, { rows: r1 - r0 + 1, cols: c1 - c0 + 1 });
    for (const cell of inside) if (cell !== key) covered.set(cell, key);
  }
  const lines = (list: TableLine[]) => list.map(line => `${line.id}@${line.pos}*${line.size}`).join(',');
  return { rows, cols, cells, merges, covered, signature: `${lines(rows)}|${lines(cols)}|${[...cells.keys()].join(',')}|${looks.join(',')}` };
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
  for (const [key, cell] of table.cells) {
    const json: CellJson = { content: richTextToJson(cell.content) };
    if (cell.fill) json.fill = cell.fill;
    const block = table.merges.get(key);
    const place = block ? cellPlace(table, key) : null;
    if (block && place) json.merge = cellKey(table.rows[place.row + block.rows - 1]!.id, table.cols[place.col + block.cols - 1]!.id);
    for (const side of SIDES) {
      const border = cell.borders?.[side];
      if (border) json[`b${side}`] = borderValue(border);
    }
    cells[key] = json;
  }
  return { rows: table.rows.map(line => ({ ...line })), cols: table.cols.map(line => ({ ...line })), cells };
}

/** Whether a table as plain data uses what needs format version 3: merged cells or lines of their own. */
export function tableNeedsV3(json: TableJson | undefined): boolean {
  return !!json && Object.values(json.cells ?? {}).some(cell => !!cell && (cell.merge || cell.bt || cell.bb || cell.bl || cell.br));
}

function lineMap(line: TableLine): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('pos', line.pos);
  if (line.size !== 1) map.set('size', line.size);
  return map;
}

export function cellMap(content: RichTextJson | null, extra: Partial<Omit<CellJson, 'content'>> = {}): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  const fragment = new Y.XmlFragment();
  map.set('content', fragment);
  const nodes = content ? richTextNodesFromJson(content) : [];
  if (nodes.length) fragment.insert(0, nodes);
  const fill = colourOf(extra.fill);
  if (fill) map.set('fill', fill);
  if (typeof extra.merge === 'string' && /^[a-z0-9]{1,16}:[a-z0-9]{1,16}$/.test(extra.merge)) map.set('merge', extra.merge);
  for (const side of SIDES) {
    const border = readBorder(extra[`b${side}`]);
    if (border) map.set(`b${side}`, borderValue(border));
  }
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
      const cell = (cells as Record<string, Partial<CellJson> | undefined>)[key];
      cellsMap.set(key, cellMap(cell?.content ?? null, cell && typeof cell === 'object' ? cell : {}));
    }
  }
}

function lines(map: Y.Map<unknown>, kind: 'rows' | 'cols'): Y.Map<Y.Map<unknown>> | null {
  const value = map.get(kind);
  return value instanceof Y.Map ? value as Y.Map<Y.Map<unknown>> : null;
}

export function cells(map: Y.Map<unknown>): Y.Map<Y.Map<unknown>> | null {
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

/** Takes a row or column away with its cells. A merged block it crossed loses that line and stays merged. */
export function removeLine(map: Y.Map<unknown>, kind: 'rows' | 'cols', id: string): void {
  const target = lines(map, kind);
  const cellStore = cells(map);
  const table = readTable(map);
  if (!target || !cellStore || !table) return;
  const at = (kind === 'rows' ? table.rows : table.cols).findIndex(line => line.id === id);
  if (at >= 0) {
    const rowIds = table.rows.map(line => line.id);
    const colIds = table.cols.map(line => line.id);
    (kind === 'rows' ? rowIds : colIds).splice(at, 1);
    for (const [anchor, block] of table.merges) {
      const place = cellPlace(table, anchor)!;
      const first = kind === 'rows' ? place.row : place.col;
      const span = kind === 'rows' ? block.rows : block.cols;
      if (at < first || at >= first + span) continue;
      cellStore.get(anchor)?.delete('merge');
      const r1 = place.row + block.rows - 1 - (kind === 'rows' ? 1 : 0);
      const c1 = place.col + block.cols - 1 - (kind === 'cols' ? 1 : 0);
      if (r1 === place.row && c1 === place.col) continue;
      // Positions after the removed line move up by one; the block's first line stays where it was.
      const newAnchor = cellKey(rowIds[place.row]!, colIds[place.col]!);
      if (!cellStore.get(newAnchor)) cellStore.set(newAnchor, cellMap(null));
      cellStore.get(newAnchor)!.set('merge', cellKey(rowIds[r1]!, colIds[c1]!));
    }
  }
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

/** Sets the size of one row or column, as a share among the others. */
export function setLineSize(map: Y.Map<unknown>, kind: 'rows' | 'cols', id: string, size: number): void {
  const line = lines(map, kind)?.get(id);
  if (!line || !(size > 0) || !Number.isFinite(size)) return;
  const rounded = Math.round(size * 10000) / 10000;
  if (rounded === 1) {
    if (line.has('size')) line.delete('size');
  } else if (line.get('size') !== rounded) {
    line.set('size', rounded);
  }
}

/** The keys of the cells in a rectangle, row by row. */
export function rectKeys(table: TableData, rect: CellRect): string[] {
  const keys: string[] = [];
  for (let r = rect.r0; r <= rect.r1; r += 1) {
    for (let c = rect.c0; c <= rect.c1; c += 1) {
      const row = table.rows[r];
      const col = table.cols[c];
      if (row && col) keys.push(cellKey(row.id, col.id));
    }
  }
  return keys;
}

/** The rectangle two cells span, grown until no merged block sticks out of it. */
export function cellRect(table: TableData, from: string, to: string): CellRect | null {
  const a = cellPlace(table, from);
  const b = cellPlace(table, to);
  if (!a || !b) return null;
  const rect = { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) };
  for (let changed = true; changed;) {
    changed = false;
    for (const [anchor, block] of table.merges) {
      const place = cellPlace(table, anchor)!;
      const r1 = place.row + block.rows - 1;
      const c1 = place.col + block.cols - 1;
      if (place.row > rect.r1 || r1 < rect.r0 || place.col > rect.c1 || c1 < rect.c0) continue;
      const grown = { r0: Math.min(rect.r0, place.row), r1: Math.max(rect.r1, r1), c0: Math.min(rect.c0, place.col), c1: Math.max(rect.c1, c1) };
      if (grown.r0 !== rect.r0 || grown.r1 !== rect.r1 || grown.c0 !== rect.c0 || grown.c1 !== rect.c1) {
        Object.assign(rect, grown);
        changed = true;
      }
    }
  }
  return rect;
}

export type BorderChoice = 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right';

/** Every text of a table, cell by cell, row by row; only those of `only` when given. */
export function tableFragments(map: Y.Map<unknown>, only?: ReadonlySet<string>): Y.XmlFragment[] {
  const table = readTable(map);
  if (!table) return [];
  const result: Y.XmlFragment[] = [];
  for (const row of table.rows) {
    for (const col of table.cols) {
      const key = cellKey(row.id, col.id);
      if (only && !only.has(key)) continue;
      const content = table.cells.get(key)?.content;
      if (content) result.push(content);
    }
  }
  return result;
}

/** The cell after (or before, when `back`) the given one, row by row; null past either end. Cells under a merged block are passed over. */
export function stepCell(table: TableData, key: string, back: boolean): string | null {
  const order = table.rows.flatMap(row => table.cols.map(col => cellKey(row.id, col.id))).filter(cell => !table.covered.has(cell));
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

/** Where every line of a table falls, in slide units from its top-left corner: rows down, columns across. */
export function lineEdges(table: TableData, w: number, h: number): { xs: number[]; ys: number[] } {
  const along = (list: TableLine[], length: number) => {
    const total = list.reduce((sum, line) => sum + line.size, 0) || 1;
    const edges = [0];
    for (const line of list) edges.push(edges[edges.length - 1]! + length * line.size / total);
    return edges;
  };
  return { xs: along(table.cols, w), ys: along(table.rows, h) };
}

/** The line drawn along an edge: a cell's own on either side, or the table's. Null for none. */
export function edgeBorder(table: TableData, a: string | null, aSide: Side, b: string | null, bSide: Side, fallback: CellBorder | null): CellBorder | null {
  const own = (a ? table.cells.get(a)?.borders?.[aSide] : undefined) ?? (b ? table.cells.get(b)?.borders?.[bSide] : undefined);
  if (own === 'none') return null;
  return own ?? fallback;
}
