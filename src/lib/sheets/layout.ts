/** Where rows, columns and cells are on screen. All sizes are CSS pixels. */
import { rectContains, type Rect } from './address';

export const HEADER_HEIGHT = 24;
/** Pixels on either side of a header border that grab it for resizing. */
export const RESIZE_GRIP = 5;
export const FILL_HANDLE = 7;
/** Size of the button a filter puts into each cell of its header row, and its distance from the cell's edge. */
export const FILTER_BUTTON = 16;
export const FILTER_BUTTON_INSET = 3;

/** The positions of the rows, or of the columns, laid end to end. */
export class AxisLayout {
  readonly count: number;
  private readonly offsets: Float64Array;

  constructor(sizes: ArrayLike<number>) {
    this.count = sizes.length;
    this.offsets = new Float64Array(sizes.length + 1);
    for (let index = 0; index < sizes.length; index += 1) this.offsets[index + 1] = this.offsets[index] + sizes[index];
  }

  get total(): number {
    return this.offsets[this.count];
  }

  start(index: number): number {
    return this.offsets[Math.max(0, Math.min(index, this.count))];
  }

  end(index: number): number {
    return this.offsets[Math.max(0, Math.min(index + 1, this.count))];
  }

  size(index: number): number {
    return this.end(index) - this.start(index);
  }

  /** The row or column at a distance from the start; the nearest one when outside. */
  indexAt(offset: number): number {
    if (this.count === 0) return 0;
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.offsets[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }
}

export function headerWidthFor(rowCount: number): number {
  return Math.max(46, String(rowCount).length * 8 + 18);
}

/** What the grid shows right now. */
export interface Viewport {
  rows: AxisLayout;
  cols: AxisLayout;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  freezeRows: number;
  freezeCols: number;
  headerWidth: number;
}

/** One of up to four areas of cells: frozen or scrolling, in each direction. */
export interface Pane {
  /** The part of the canvas the pane covers. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Add to a column's or row's start to get its place on the canvas. */
  offsetX: number;
  offsetY: number;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
}

export function frozenWidth(view: Viewport): number {
  return view.cols.start(view.freezeCols);
}

export function frozenHeight(view: Viewport): number {
  return view.rows.start(view.freezeRows);
}

interface Band {
  start: number;
  size: number;
  offset: number;
  from: number;
  to: number;
}

function bands(axis: AxisLayout, frozenCount: number, header: number, extent: number, scroll: number): Band[] {
  const frozen = axis.start(frozenCount);
  const out: Band[] = [];
  if (frozenCount > 0) out.push({ start: header, size: Math.min(frozen, extent - header), offset: header, from: 0, to: frozenCount - 1 });
  const start = header + frozen;
  if (extent > start && axis.count > frozenCount) {
    out.push({
      start,
      size: extent - start,
      offset: header - scroll,
      from: Math.max(frozenCount, axis.indexAt(frozen + scroll)),
      to: axis.indexAt(scroll + extent - header - 1),
    });
  }
  return out;
}

export function panesOf(view: Viewport): Pane[] {
  const panes: Pane[] = [];
  const columns = bands(view.cols, view.freezeCols, view.headerWidth, view.width, view.scrollX);
  const rows = bands(view.rows, view.freezeRows, HEADER_HEIGHT, view.height, view.scrollY);
  for (const row of rows) {
    for (const column of columns) {
      panes.push({
        x: column.start,
        y: row.start,
        width: column.size,
        height: row.size,
        offsetX: column.offset,
        offsetY: row.offset,
        rowFrom: row.from,
        rowTo: row.to,
        colFrom: column.from,
        colTo: column.to,
      });
    }
  }
  return panes;
}

/** Where a column starts on the canvas. Frozen columns do not scroll. */
export function columnX(view: Viewport, col: number): number {
  return view.headerWidth + view.cols.start(col) - (col < view.freezeCols ? 0 : view.scrollX);
}

export function rowY(view: Viewport, row: number): number {
  return HEADER_HEIGHT + view.rows.start(row) - (row < view.freezeRows ? 0 : view.scrollY);
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The place of a rectangle of cells on the canvas, ignoring what hides behind frozen panes. */
export function rectOnScreen(view: Viewport, rect: Rect): ScreenRect {
  const x = columnX(view, rect.c1);
  const y = rowY(view, rect.r1);
  return {
    x,
    y,
    width: columnX(view, rect.c2) + view.cols.size(rect.c2) - x,
    height: rowY(view, rect.r2) + view.rows.size(rect.r2) - y,
  };
}

export type HitArea = 'corner' | 'colHeader' | 'rowHeader' | 'cell';

export interface Hit {
  area: HitArea;
  row: number;
  col: number;
  /** The column whose right border is under the pointer, in the column header. */
  colEdge: number | null;
  /** The row whose bottom border is under the pointer, in the row header. */
  rowEdge: number | null;
}

/** What is under a point of the canvas. */
export function hitTest(view: Viewport, x: number, y: number): Hit {
  const inColumnHeader = y < HEADER_HEIGHT;
  const inRowHeader = x < view.headerWidth;
  const frozenX = frozenWidth(view);
  const frozenY = frozenHeight(view);
  const contentX = x - view.headerWidth + (x - view.headerWidth < frozenX ? 0 : view.scrollX);
  const contentY = y - HEADER_HEIGHT + (y - HEADER_HEIGHT < frozenY ? 0 : view.scrollY);
  const col = view.cols.indexAt(Math.max(0, contentX));
  const row = view.rows.indexAt(Math.max(0, contentY));
  let colEdge: number | null = null;
  let rowEdge: number | null = null;
  if (inColumnHeader && !inRowHeader) {
    if (view.cols.end(col) - contentX <= RESIZE_GRIP) colEdge = col;
    else if (contentX - view.cols.start(col) <= RESIZE_GRIP && col > 0) colEdge = col - 1;
  }
  if (inRowHeader && !inColumnHeader) {
    if (view.rows.end(row) - contentY <= RESIZE_GRIP) rowEdge = row;
    else if (contentY - view.rows.start(row) <= RESIZE_GRIP && row > 0) rowEdge = row - 1;
  }
  const area: HitArea = inColumnHeader && inRowHeader ? 'corner' : inColumnHeader ? 'colHeader' : inRowHeader ? 'rowHeader' : 'cell';
  return { area, row, col, colEdge, rowEdge };
}

/** How far to scroll so a cell is fully in view; frozen cells are always in view. */
export function scrollToShow(view: Viewport, row: number, col: number): { scrollX: number; scrollY: number } {
  let { scrollX, scrollY } = view;
  if (col >= view.freezeCols) {
    const frozen = frozenWidth(view);
    const room = view.width - view.headerWidth - frozen;
    const start = view.cols.start(col) - frozen;
    const end = view.cols.end(col) - frozen;
    if (start < scrollX) scrollX = start;
    else if (end > scrollX + room) scrollX = Math.min(start, end - room);
  }
  if (row >= view.freezeRows) {
    const frozen = frozenHeight(view);
    const room = view.height - HEADER_HEIGHT - frozen;
    const start = view.rows.start(row) - frozen;
    const end = view.rows.end(row) - frozen;
    if (start < scrollY) scrollY = start;
    else if (end > scrollY + room) scrollY = Math.min(start, end - room);
  }
  return { scrollX: Math.max(0, scrollX), scrollY: Math.max(0, scrollY) };
}

/** Whether a point is on the small square at the corner of the selection. */
export function overFillHandle(view: Viewport, selection: Rect, x: number, y: number): boolean {
  const corner = rectOnScreen(view, { r1: selection.r2, c1: selection.c2, r2: selection.r2, c2: selection.c2 });
  const cx = corner.x + corner.width - 1;
  const cy = corner.y + corner.height - 1;
  // Hidden behind a frozen pane, the handle is not there to grab.
  if (selection.c2 >= view.freezeCols && cx < view.headerWidth + frozenWidth(view)) return false;
  if (selection.r2 >= view.freezeRows && cy < HEADER_HEIGHT + frozenHeight(view)) return false;
  return Math.abs(x - cx) <= FILL_HANDLE && Math.abs(y - cy) <= FILL_HANDLE;
}

/** The selection stretched to a cell outside it, up, down, left or right; null for a cell inside. */
export function stretchTo(selection: Rect, row: number, col: number): Rect | null {
  if (rectContains(selection, row, col)) return null;
  const down = row > selection.r2 ? row - selection.r2 : 0;
  const up = row < selection.r1 ? selection.r1 - row : 0;
  const right = col > selection.c2 ? col - selection.c2 : 0;
  const left = col < selection.c1 ? selection.c1 - col : 0;
  if (Math.max(down, up) >= Math.max(right, left)) return { ...selection, r1: selection.r1 - up, r2: selection.r2 + down };
  return { ...selection, c1: selection.c1 - left, c2: selection.c2 + right };
}

/**
 * Where rows or columns dragged by their header would be dropped: the
 * position they would sit before. Null when that is where they already are.
 */
export function dropPosition(view: Viewport, axis: 'row' | 'col', from: number, to: number, x: number, y: number): number | null {
  const hit = hitTest(view, Math.max(view.headerWidth + 1, x), Math.max(HEADER_HEIGHT + 1, y));
  const layout = axis === 'col' ? view.cols : view.rows;
  const index = axis === 'col' ? hit.col : hit.row;
  const start = axis === 'col' ? columnX(view, index) : rowY(view, index);
  const before = (axis === 'col' ? x : y) < start + layout.size(index) / 2;
  const position = before ? index : index + 1;
  return position >= from && position <= to + 1 ? null : position;
}
