/**
 * How a spreadsheet is kept in its Yjs document (format version 1).
 *
 * Several devices and people edit one spreadsheet and their saved changes are
 * merged seconds later, so the format is built to merge:
 *
 * - Rows and columns have lasting ids. Each sheet keeps the order of its row
 *   ids and of its column ids in two arrays, and a cell is stored under
 *   "rowId:colId". Inserting, deleting or moving a row touches the order
 *   only, never the cells, and two people editing different cells never
 *   collide. Formulas name cells by these ids too (see formula/tokens.ts), so
 *   they follow their cells without being rewritten.
 * - A deleted row or column is not taken out of the order; it is marked gone
 *   and its cells are emptied. A range that ended in it can then shrink to
 *   its neighbour, and undoing the deletion brings everything back.
 * - A moved row is taken out and put back in the order. If two devices move
 *   the same row at once it ends up listed twice; the first place counts.
 *   The same rule lets two devices that both start the same empty
 *   spreadsheet end up with one grid: the first rows and columns of a sheet
 *   get the same ids ("0", "1", "2" … in base 36) everywhere.
 * - Nothing is nested. Every sheet's data lives in shared types at the top
 *   of the document, named by the sheet id, because a nested type created on
 *   two devices at once would have one of them thrown away with its content.
 *
 * Top level of the document:
 *
 *   book           Map    version: 1
 *                         name:<sheetId>  the sheet's name
 *                         gone:<sheetId>  true once the sheet is deleted
 *   sheets         Array  sheet ids in tab order
 *   <sheetId>:rows Array  row ids in order
 *   <sheetId>:cols Array  column ids in order
 *   <sheetId>:cells Map   "rowId:colId" -> number | boolean | text.
 *                         Text starting with "=" is a formula, in which a
 *                         cell is written [colId,rowId], a range
 *                         [colId,rowId]:[colId,rowId], with "$" before a
 *                         fixed id and "sheetId!" for another sheet, as in
 *                         =SUM([b,1]:[b,9])*[2k!$a,$0]. Text starting with
 *                         "'" is the rest of it taken literally.
 *   <sheetId>:styles Map  "rowId:colId", "rowId:" (whole row) or ":colId"
 *                         (whole column) -> CellStyle. A cell's look is its
 *                         column's, overridden by its row's, overridden by
 *                         its own.
 *   <sheetId>:props Map   w:<colId> width, h:<rowId> height, in pixels
 *                         xr:<rowId>, xc:<colId>  true once deleted
 *                         hr:<rowId>, hc:<colId>  true while hidden
 *                         freezeRows, freezeCols  how many stay in view
 *
 * Whole values are replaced, last writer wins: one cell's content, one
 * cell's style, one width.
 */
import * as Y from 'yjs';
import type { Rect } from './address';

export const FORMAT_VERSION = 1;
/** Transaction origin of this person's own edits; undo steps through these only. */
export const LOCAL_ORIGIN = 'sheet-edit';
const SETUP_ORIGIN = 'sheet-setup';

export const DEFAULT_ROWS = 1000;
export const DEFAULT_COLS = 26;
export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_HEIGHT = 24;
export const MIN_COL_WIDTH = 24;
export const MIN_ROW_HEIGHT = 16;
/** Sheets stop growing here; beyond it a browser tab struggles. */
export const MAX_ROWS = 100_000;
export const MAX_COLS = 2_000;

export type CellRaw = number | string | boolean;

/**
 * How a cell looks. As stored, 0 and "" switch a property off where the row
 * or column has it on; `Sheet.styleAt` gives the outcome without them.
 */
export interface CellStyle {
  /** Bold, italic, strikethrough, underline. */
  b?: 0 | 1;
  i?: 0 | 1;
  s?: 0 | 1;
  u?: 0 | 1;
  /** Text colour and fill colour, as #rrggbb. */
  c?: string;
  bg?: string;
  /** Alignment: left, centre, right. */
  a?: 'l' | 'c' | 'r' | '';
  /** Wrap long text onto more lines. */
  w?: 0 | 1;
  /** Number format pattern (see format.ts). */
  nf?: string;
}

/** A change to a style: a value sets a property, null clears it. */
export type StylePatch = { [K in keyof CellStyle]?: CellStyle[K] | null };

const EMPTY_STYLE: CellStyle = Object.freeze({});

export function newId(): string {
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += (byte % 36).toString(36);
  return id;
}

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

/** Text as the cells map stores it. */
export function encodeText(text: string): string {
  return text.startsWith('=') || text.startsWith("'") ? `'${text}` : text;
}

export function isFormula(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 1 && raw.startsWith('=');
}

/** The value a stored entry stands for, when it is not a formula. */
export function decodeRaw(raw: CellRaw | undefined): number | string | boolean | null {
  if (raw === undefined) return null;
  if (typeof raw === 'string' && raw.startsWith("'")) return raw.slice(1);
  return raw;
}

/** The order of one sheet's rows or columns. */
export class Axis {
  /** Ids in order, without the deleted ones. */
  ids: string[] = [];
  private positions = new Map<string, number>();
  /** For a deleted id: how many living ids come before it. */
  private slots = new Map<string, number>();

  rebuild(listed: string[], isGone: (id: string) => boolean): void {
    const ids: string[] = [];
    const positions = new Map<string, number>();
    const slots = new Map<string, number>();
    for (const id of listed) {
      if (positions.has(id) || slots.has(id)) continue;
      if (isGone(id)) {
        slots.set(id, ids.length);
      } else {
        positions.set(id, ids.length);
        ids.push(id);
      }
    }
    this.ids = ids;
    this.positions = positions;
    this.slots = slots;
  }

  get length(): number {
    return this.ids.length;
  }

  /** Position of a living id, or -1. */
  indexOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  /**
   * The positions a range between two ids covers now. An end that was
   * deleted gives way to its nearest living neighbour inside the range.
   * Null when nothing of the range is left or an id is unknown.
   */
  span(first: string, second: string): [number, number] | null {
    const a = this.place(first);
    const b = this.place(second);
    if (!a || !b) return null;
    const [low, high] = a.order <= b.order ? [a, b] : [b, a];
    // A deleted end sits just before the living id at its slot.
    const from = low.at;
    const to = high.alive ? high.at : high.at - 1;
    return from <= to && to < this.ids.length ? [from, to] : null;
  }

  private place(id: string): { at: number; alive: boolean; order: number } | null {
    const position = this.positions.get(id);
    if (position !== undefined) return { at: position, alive: true, order: position };
    const slot = this.slots.get(id);
    return slot === undefined ? null : { at: slot, alive: false, order: slot - 0.5 };
  }
}

type SheetPart = 'rows' | 'cols' | 'cells' | 'styles' | 'props';

/** What one transaction changed, for whoever redraws or recalculates. */
export interface SheetChange {
  /** Cells whose content changed, as "rowId:colId". */
  cells: Set<string>;
  /** Rows or columns were added, removed or moved. */
  axes: boolean;
  styles: boolean;
  /** Widths, heights or frozen panes. */
  props: boolean;
}

export interface BookChange {
  /** Sheets were added, removed, renamed or reordered. */
  sheets: boolean;
  bySheet: Map<string, SheetChange>;
  /** Made by this person here, rather than loaded or received. */
  local: boolean;
}

export class Sheet {
  readonly id: string;
  readonly rowOrder: Y.Array<string>;
  readonly colOrder: Y.Array<string>;
  readonly cells: Y.Map<CellRaw>;
  readonly styles: Y.Map<CellStyle>;
  readonly props: Y.Map<unknown>;
  readonly rows = new Axis();
  readonly cols = new Axis();
  private readonly doc: Y.Doc;
  private styleCache = new Map<string, CellStyle>();
  private used: Rect | null | undefined;

  constructor(doc: Y.Doc, id: string) {
    this.doc = doc;
    this.id = id;
    this.rowOrder = doc.getArray(`${id}:rows`);
    this.colOrder = doc.getArray(`${id}:cols`);
    this.cells = doc.getMap(`${id}:cells`);
    this.styles = doc.getMap(`${id}:styles`);
    this.props = doc.getMap(`${id}:props`);
    this.rebuildAxes();
  }

  get types(): Y.AbstractType<unknown>[] {
    return [this.rowOrder, this.colOrder, this.cells, this.styles, this.props] as Y.AbstractType<unknown>[];
  }

  rebuildAxes(): void {
    this.rows.rebuild(this.rowOrder.toArray(), id => this.props.get(`xr:${id}`) === true);
    this.cols.rebuild(this.colOrder.toArray(), id => this.props.get(`xc:${id}`) === true);
    this.used = undefined;
  }

  forgetCaches(part: SheetPart): void {
    if (part === 'styles') this.styleCache.clear();
    if (part === 'cells') this.used = undefined;
  }

  private transact(run: () => void): void {
    this.doc.transact(run, LOCAL_ORIGIN);
  }

  // --- Cells ---

  rawAt(row: number, col: number): CellRaw | undefined {
    const rowId = this.rows.ids[row];
    const colId = this.cols.ids[col];
    return rowId === undefined || colId === undefined ? undefined : this.cells.get(cellKey(rowId, colId));
  }

  isEmpty(row: number, col: number): boolean {
    return this.rawAt(row, col) === undefined;
  }

  setRaw(row: number, col: number, raw: CellRaw | null): void {
    const rowId = this.rows.ids[row];
    const colId = this.cols.ids[col];
    if (rowId === undefined || colId === undefined) return;
    const key = cellKey(rowId, colId);
    this.transact(() => {
      if (raw === null || raw === '') {
        if (this.cells.has(key)) this.cells.delete(key);
      } else if (this.cells.get(key) !== raw) {
        this.cells.set(key, raw);
      }
    });
    this.used = undefined;
  }

  /** The smallest rectangle holding every cell with content, or null for an empty sheet. */
  usedRect(): Rect | null {
    if (this.used !== undefined) return this.used;
    let r2 = -1;
    let c2 = -1;
    for (const key of this.cells.keys()) {
      const at = key.indexOf(':');
      const row = this.rows.indexOf(key.slice(0, at));
      const col = this.cols.indexOf(key.slice(at + 1));
      if (row < 0 || col < 0) continue;
      if (row > r2) r2 = row;
      if (col > c2) c2 = col;
    }
    this.used = r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 };
    return this.used;
  }

  // --- Looks ---

  /** How the cell looks: its own style over its row's over its column's. */
  styleAt(row: number, col: number): CellStyle {
    const rowId = this.rows.ids[row];
    const colId = this.cols.ids[col];
    if (rowId === undefined || colId === undefined) return EMPTY_STYLE;
    const key = cellKey(rowId, colId);
    let style = this.styleCache.get(key);
    if (style) return style;
    const own = this.styles.get(key);
    const ofRow = this.styles.get(`${rowId}:`);
    const ofCol = this.styles.get(`:${colId}`);
    const layers = [ofCol, ofRow, own].filter(Boolean) as CellStyle[];
    if (layers.length === 0) {
      style = EMPTY_STYLE;
    } else {
      // What is left after a property switched off above a layer that had it on.
      const merged: Record<string, unknown> = Object.assign({}, ...layers);
      for (const prop of Object.keys(merged)) if (merged[prop] === 0 || merged[prop] === '') delete merged[prop];
      style = merged as CellStyle;
    }
    if (this.styleCache.size > 50_000) this.styleCache.clear();
    this.styleCache.set(key, style);
    return style;
  }

  private writeStyle(key: string, style: CellStyle): void {
    if (this.styleCache.size > 0) this.styleCache.clear();
    if (Object.keys(style).length === 0) {
      if (this.styles.has(key)) this.styles.delete(key);
    } else {
      this.styles.set(key, style);
    }
  }

  /**
   * Changes how cells look. `scope` says whether the rectangle stands for
   * whole rows, whole columns or the whole sheet, which are then styled as
   * such rather than cell by cell.
   */
  patchStyle(rect: Rect, patch: StylePatch, scope: 'cells' | 'rows' | 'cols' | 'all' = 'cells'): void {
    const props = Object.keys(patch) as Array<keyof CellStyle>;
    if (props.length === 0) return;
    const off = (prop: keyof CellStyle): 0 | '' => (prop === 'c' || prop === 'bg' || prop === 'a' || prop === 'nf' ? '' : 0);
    const isOn = (value: unknown) => value !== undefined && value !== null && value !== 0 && value !== '';
    /** Applies the patch to one stored style, given what shows through from underneath. */
    const apply = (current: CellStyle | undefined, below: CellStyle | undefined): CellStyle => {
      const next: Record<string, unknown> = { ...current };
      for (const prop of props) {
        const value = patch[prop];
        if (value === null || value === undefined || !isOn(value)) {
          if (below && isOn(below[prop])) next[prop] = off(prop);
          else delete next[prop];
        } else if (below && below[prop] === value) {
          delete next[prop];
        } else {
          next[prop] = value;
        }
      }
      return next as CellStyle;
    };
    const drop = (current: CellStyle): CellStyle => {
      const next: Record<string, unknown> = { ...current };
      for (const prop of props) delete next[prop];
      return next as CellStyle;
    };

    this.transact(() => {
      if (scope === 'cells') {
        for (let row = rect.r1; row <= rect.r2; row += 1) {
          const rowId = this.rows.ids[row];
          const ofRow = this.styles.get(`${rowId}:`);
          for (let col = rect.c1; col <= rect.c2; col += 1) {
            const colId = this.cols.ids[col];
            const ofCol = this.styles.get(`:${colId}`);
            const below = ofRow && ofCol ? { ...ofCol, ...ofRow } : ofRow ?? ofCol;
            const key = cellKey(rowId, colId);
            this.writeStyle(key, apply(this.styles.get(key), below));
          }
        }
        return;
      }

      const rowIds = new Set(scope === 'rows' ? this.rows.ids.slice(rect.r1, rect.r2 + 1) : []);
      const colIds = new Set(scope === 'cols' ? this.cols.ids.slice(rect.c1, rect.c2 + 1) : scope === 'all' ? this.cols.ids : []);
      const styledRows: string[] = [];
      // Cells and rows that had their own say on these properties give it up.
      for (const [key, style] of [...this.styles.entries()]) {
        const at = key.indexOf(':');
        const rowId = key.slice(0, at);
        const colId = key.slice(at + 1);
        if (rowId && colId) {
          if (scope === 'all' || rowIds.has(rowId) || colIds.has(colId)) this.writeStyle(key, drop(style));
        } else if (rowId && !colId) {
          if (scope === 'all') this.writeStyle(key, drop(style));
          else if (scope === 'cols' && props.some(prop => style[prop] !== undefined)) styledRows.push(rowId);
        }
      }
      if (scope === 'rows') {
        const anyColumnHas = (prop: keyof CellStyle) => this.cols.ids.some(colId => isOn(this.styles.get(`:${colId}`)?.[prop]));
        const below: CellStyle = {};
        for (const prop of props) if (anyColumnHas(prop)) (below as Record<string, unknown>)[prop] = 1;
        for (const rowId of rowIds) {
          const next: Record<string, unknown> = { ...this.styles.get(`${rowId}:`) };
          for (const prop of props) {
            const value = patch[prop];
            if (isOn(value)) next[prop] = value;
            else if (isOn(below[prop])) next[prop] = off(prop);
            else delete next[prop];
          }
          this.writeStyle(`${rowId}:`, next as CellStyle);
        }
        return;
      }
      for (const colId of colIds) {
        this.writeStyle(`:${colId}`, apply(this.styles.get(`:${colId}`), undefined));
        // A styled row would hide the column's new look where they cross.
        for (const rowId of styledRows) {
          const key = cellKey(rowId, colId);
          const ofRow = this.styles.get(`${rowId}:`);
          const next: Record<string, unknown> = { ...this.styles.get(key) };
          for (const prop of props) {
            if (ofRow?.[prop] === undefined) continue;
            const wanted = isOn(patch[prop]) ? patch[prop] : off(prop);
            const rowSaysSame = isOn(ofRow[prop]) ? ofRow[prop] === wanted : !isOn(wanted);
            if (rowSaysSame) delete next[prop];
            else next[prop] = wanted;
          }
          this.writeStyle(key, next as CellStyle);
        }
      }
    });
  }

  /** Removes every look from the cells, rows or columns the rectangle stands for. */
  clearStyle(rect: Rect, scope: 'cells' | 'rows' | 'cols' | 'all' = 'cells'): void {
    this.patchStyle(rect, { b: null, i: null, s: null, u: null, c: null, bg: null, a: null, w: null, nf: null }, scope);
  }

  // --- Sizes ---

  colWidth(col: number): number {
    return (this.props.get(`w:${this.cols.ids[col]}`) as number | undefined) ?? DEFAULT_COL_WIDTH;
  }

  /** The height someone gave the row, or undefined when it follows its content. */
  rowHeight(row: number): number | undefined {
    return this.props.get(`h:${this.rows.ids[row]}`) as number | undefined;
  }

  setColWidth(from: number, to: number, width: number | null): void {
    this.transact(() => {
      for (let col = from; col <= to; col += 1) {
        const key = `w:${this.cols.ids[col]}`;
        if (width === null) this.props.delete(key);
        else this.props.set(key, Math.max(MIN_COL_WIDTH, Math.round(width)));
      }
    });
  }

  setRowHeight(from: number, to: number, height: number | null): void {
    this.transact(() => {
      for (let row = from; row <= to; row += 1) {
        const key = `h:${this.rows.ids[row]}`;
        if (height === null) this.props.delete(key);
        else this.props.set(key, Math.max(MIN_ROW_HEIGHT, Math.round(height)));
      }
    });
  }

  /** Positions of the rows, or of the columns, that someone has hidden. */
  hidden(axis: 'row' | 'col'): Set<number> {
    const out = new Set<number>();
    const prefix = axis === 'row' ? 'hr:' : 'hc:';
    const live = axis === 'row' ? this.rows : this.cols;
    for (const [key, value] of this.props.entries()) {
      if (value !== true || !key.startsWith(prefix)) continue;
      const index = live.indexOf(key.slice(3));
      if (index >= 0) out.add(index);
    }
    return out;
  }

  /** Hides or shows rows or columns. At least one always stays in view. */
  setHidden(axis: 'row' | 'col', from: number, to: number, hide: boolean): void {
    const live = axis === 'row' ? this.rows : this.cols;
    const prefix = axis === 'row' ? 'hr:' : 'hc:';
    const already = this.hidden(axis);
    this.transact(() => {
      for (let index = from; index <= to; index += 1) {
        const key = `${prefix}${live.ids[index]}`;
        if (!hide) this.props.delete(key);
        else if (already.size + 1 < live.length && !already.has(index)) {
          this.props.set(key, true);
          already.add(index);
        }
      }
    });
  }

  get freezeRows(): number {
    return Math.min((this.props.get('freezeRows') as number | undefined) ?? 0, Math.max(0, this.rows.length - 1));
  }

  get freezeCols(): number {
    return Math.min((this.props.get('freezeCols') as number | undefined) ?? 0, Math.max(0, this.cols.length - 1));
  }

  setFreeze(rows: number, cols: number): void {
    this.transact(() => {
      if (rows > 0) this.props.set('freezeRows', rows);
      else this.props.delete('freezeRows');
      if (cols > 0) this.props.set('freezeCols', cols);
      else this.props.delete('freezeCols');
    });
  }

  // --- Rows and columns ---

  private axisParts(axis: 'row' | 'col') {
    return axis === 'row'
      ? { order: this.rowOrder, live: this.rows, gone: 'xr:', limit: MAX_ROWS }
      : { order: this.colOrder, live: this.cols, gone: 'xc:', limit: MAX_COLS };
  }

  /** Adds `count` rows or columns before position `at` and returns how many were added. */
  insert(axis: 'row' | 'col', at: number, count: number): number {
    const { order, live, limit } = this.axisParts(axis);
    const room = Math.max(0, Math.min(count, limit - live.length));
    if (room === 0) return 0;
    const ids = Array.from({ length: room }, newId);
    this.transact(() => {
      const before = live.ids[at];
      const listed = order.toArray();
      const index = before === undefined ? listed.length : listed.indexOf(before);
      order.insert(index, ids);
    });
    // Positions are right at once, also for a caller in the middle of a larger step.
    this.rebuildAxes();
    return room;
  }

  /** Deletes rows or columns, emptying their cells. At least one always stays. */
  remove(axis: 'row' | 'col', from: number, count: number): void {
    const { live, gone } = this.axisParts(axis);
    const ids = live.ids.slice(from, from + Math.min(count, live.length - 1));
    if (ids.length === 0) return;
    const doomed = new Set(ids);
    this.transact(() => {
      for (const map of [this.cells, this.styles] as Array<Y.Map<unknown>>) {
        for (const key of [...map.keys()]) {
          const at = key.indexOf(':');
          if (doomed.has(axis === 'row' ? key.slice(0, at) : key.slice(at + 1))) map.delete(key);
        }
      }
      for (const id of ids) {
        this.props.set(`${gone}${id}`, true);
        this.props.delete(`${axis === 'row' ? 'h' : 'w'}:${id}`);
        this.props.delete(`${axis === 'row' ? 'hr' : 'hc'}:${id}`);
      }
    });
    this.styleCache.clear();
    this.rebuildAxes();
  }

  /** Moves `count` rows or columns starting at `from` so they sit before the one now at `to`. */
  move(axis: 'row' | 'col', from: number, count: number, to: number): void {
    const { order, live } = this.axisParts(axis);
    if (to >= from && to <= from + count) return;
    const ids = live.ids.slice(from, from + count);
    const moving = new Set(ids);
    const target = live.ids[to];
    this.transact(() => {
      const listed = order.toArray();
      for (let index = listed.length - 1; index >= 0; index -= 1) {
        if (moving.has(listed[index])) order.delete(index, 1);
      }
      const remaining = order.toArray();
      order.insert(target === undefined ? remaining.length : remaining.indexOf(target), ids);
    });
    this.rebuildAxes();
  }
}

export interface SheetInfo {
  id: string;
  name: string;
}

/** A whole spreadsheet: its sheets, and one stream of changes for everything in it. */
export class Book {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly order: Y.Array<string>;
  /** Sheets in tab order, without the deleted ones. */
  sheets: SheetInfo[] = [];
  private readonly loaded = new Map<string, Sheet>();
  private readonly owners = new Map<Y.AbstractType<unknown>, { sheet: Sheet; part: SheetPart }>();
  private readonly listeners = new Set<(change: BookChange) => void>();
  private readonly onNewSheet: Array<(sheet: Sheet) => void> = [];

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.meta = doc.getMap('book');
    this.order = doc.getArray('sheets');
    this.refreshSheets();
    doc.on('afterTransaction', this.afterTransaction);
  }

  destroy(): void {
    this.doc.off('afterTransaction', this.afterTransaction);
    this.listeners.clear();
  }

  /** True when the document was written by a newer app than this one understands. */
  get tooNew(): boolean {
    const version = this.meta.get('version');
    return typeof version === 'number' && version > FORMAT_VERSION;
  }

  get isEmpty(): boolean {
    return this.sheets.length === 0;
  }

  onChange(listener: (change: BookChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls back for every sheet as it is first used; for scoping undo. */
  onSheetLoaded(listener: (sheet: Sheet) => void): void {
    this.onNewSheet.push(listener);
    for (const sheet of this.loaded.values()) listener(sheet);
  }

  transact(run: () => void): void {
    this.doc.transact(run, LOCAL_ORIGIN);
  }

  sheet(id: string): Sheet {
    let sheet = this.loaded.get(id);
    if (!sheet) {
      sheet = new Sheet(this.doc, id);
      this.loaded.set(id, sheet);
      const parts: SheetPart[] = ['rows', 'cols', 'cells', 'styles', 'props'];
      sheet.types.forEach((type, index) => this.owners.set(type, { sheet: sheet as Sheet, part: parts[index] }));
      for (const listener of this.onNewSheet) listener(sheet);
    }
    return sheet;
  }

  sheetByName(name: string): SheetInfo | undefined {
    const wanted = name.toLowerCase();
    return this.sheets.find(sheet => sheet.name.toLowerCase() === wanted);
  }

  nameOf(id: string): string | undefined {
    return this.sheets.find(sheet => sheet.id === id)?.name;
  }

  /** A sheet name nobody uses yet: "Sheet2", "Costs (2)". */
  freeName(base = 'Sheet'): string {
    if (base !== 'Sheet' && !this.sheetByName(base)) return base;
    for (let n = base === 'Sheet' ? this.sheets.length + 1 : 2; ; n += 1) {
      const name = base === 'Sheet' ? `Sheet${n}` : `${base} (${n})`;
      if (!this.sheetByName(name)) return name;
    }
  }

  /** Gives an empty document its first sheet. Safe to run on two devices at once. */
  initialize(): void {
    if (!this.isEmpty || this.order.length > 0) return;
    // Not one of the person's edits: undo must not take the first sheet away.
    this.doc.transact(() => {
      this.meta.set('version', FORMAT_VERSION);
      this.createSheet('1', 'Sheet1', DEFAULT_ROWS, DEFAULT_COLS, 0);
    }, SETUP_ORIGIN);
  }

  private createSheet(id: string, name: string, rows: number, cols: number, at: number): void {
    const base = (count: number) => Array.from({ length: count }, (_unused, index) => index.toString(36));
    this.doc.getArray<string>(`${id}:rows`).insert(0, base(rows));
    this.doc.getArray<string>(`${id}:cols`).insert(0, base(cols));
    this.meta.set(`name:${id}`, name);
    this.order.insert(Math.min(at, this.order.length), [id]);
  }

  addSheet(name = this.freeName(), rows = DEFAULT_ROWS, cols = DEFAULT_COLS, after?: string): string {
    const id = newId();
    this.transact(() => {
      if (this.meta.get('version') === undefined) this.meta.set('version', FORMAT_VERSION);
      const listed = this.order.toArray();
      const index = after === undefined ? -1 : listed.indexOf(after);
      this.createSheet(id, name, Math.min(rows, MAX_ROWS), Math.min(cols, MAX_COLS), index < 0 ? listed.length : index + 1);
    });
    return id;
  }

  renameSheet(id: string, name: string): boolean {
    const clean = name.trim().replace(/[[\]*?:/\\]/g, ' ').slice(0, 100);
    if (!clean) return false;
    const existing = this.sheetByName(clean);
    if (existing && existing.id !== id) return false;
    this.transact(() => this.meta.set(`name:${id}`, clean));
    return true;
  }

  /** Deletes a sheet. The last one stays. */
  removeSheet(id: string): void {
    if (this.sheets.length <= 1) return;
    const sheet = this.sheet(id);
    this.transact(() => {
      this.meta.set(`gone:${id}`, true);
      for (const key of [...sheet.cells.keys()]) sheet.cells.delete(key);
      for (const key of [...sheet.styles.keys()]) sheet.styles.delete(key);
    });
  }

  /** Puts a sheet at position `to` among the tabs. */
  moveSheet(id: string, to: number): void {
    const others = this.sheets.filter(sheet => sheet.id !== id);
    const target = others[to]?.id;
    this.transact(() => {
      const listed = this.order.toArray();
      for (let index = listed.length - 1; index >= 0; index -= 1) {
        if (listed[index] === id) this.order.delete(index, 1);
      }
      const remaining = this.order.toArray();
      this.order.insert(target === undefined ? remaining.length : remaining.indexOf(target), [id]);
    });
  }

  private refreshSheets(): void {
    const seen = new Set<string>();
    const sheets: SheetInfo[] = [];
    for (const id of this.order.toArray()) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.meta.get(`gone:${id}`) === true) continue;
      sheets.push({ id, name: (this.meta.get(`name:${id}`) as string | undefined) ?? 'Sheet' });
    }
    this.sheets = sheets;
  }

  private readonly afterTransaction = (transaction: Y.Transaction): void => {
    if (transaction.changed.size === 0) return;
    const change: BookChange = { sheets: false, bySheet: new Map(), local: transaction.origin === LOCAL_ORIGIN || transaction.origin instanceof Y.UndoManager };
    const entry = (sheet: Sheet): SheetChange => {
      let found = change.bySheet.get(sheet.id);
      if (!found) {
        found = { cells: new Set(), axes: false, styles: false, props: false };
        change.bySheet.set(sheet.id, found);
      }
      return found;
    };
    // A sheet nobody has looked at yet may have been changed from elsewhere.
    for (const [type] of transaction.changed) {
      if (type === (this.meta as Y.AbstractType<unknown>) || type === (this.order as Y.AbstractType<unknown>)) change.sheets = true;
    }
    if (change.sheets) this.refreshSheets();
    for (const [type, keys] of transaction.changed) {
      const owner = this.owners.get(type as Y.AbstractType<unknown>);
      if (!owner) continue;
      const { sheet, part } = owner;
      const found = entry(sheet);
      sheet.forgetCaches(part);
      if (part === 'cells') {
        for (const key of keys) if (key !== null) found.cells.add(key);
      } else if (part === 'styles') {
        found.styles = true;
      } else if (part === 'rows' || part === 'cols') {
        found.axes = true;
      } else {
        found.props = true;
        for (const key of keys) if (key !== null && key.startsWith('x')) found.axes = true;
      }
    }
    for (const [id, found] of change.bySheet) if (found.axes) this.sheet(id).rebuildAxes();
    if (!change.sheets && change.bySheet.size === 0) return;
    for (const listener of [...this.listeners]) listener(change);
  };
}
