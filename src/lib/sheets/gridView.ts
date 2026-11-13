/** What the grid component needs worked out before it can draw: sizes and colours. */
import type { Engine } from './engine';
import type { CellPos } from './address';
import { AxisLayout, HEADER_HEIGHT, headerWidthFor, rectOnScreen, type Viewport } from './layout';
import { DEFAULT_ROW_HEIGHT, type CellStyle, type Sheet } from './model';
import { CELL_PAD_X, LINE_HEIGHT, fontOf, heightForText, textWidth, type GridTheme } from './render';

export interface GridLayout {
  rows: AxisLayout;
  cols: AxisLayout;
  headerWidth: number;
}

export interface SizeOverride {
  axis: 'row' | 'col';
  index: number;
  size: number;
}

/**
 * Row and column positions for a sheet. A row without a set height grows to
 * show wrapped text. `override` is a size being dragged, not stored yet.
 */
export function buildLayout(
  sheet: Sheet,
  engine: Engine,
  override: SizeOverride | null,
  hidden: { rows: ReadonlySet<number>; cols: ReadonlySet<number> },
): GridLayout {
  const colCount = sheet.cols.length;
  const rowCount = sheet.rows.length;
  const widths = new Float64Array(colCount);
  for (let col = 0; col < colCount; col += 1) widths[col] = sheet.colWidth(col);
  if (override?.axis === 'col' && override.index < colCount) widths[override.index] = override.size;

  const heights = new Float64Array(rowCount).fill(DEFAULT_ROW_HEIGHT);
  // Only filled cells can need more room, so only they are looked at.
  for (const [key, raw] of sheet.cells.entries()) {
    const at = key.indexOf(':');
    const row = sheet.rows.indexOf(key.slice(0, at));
    const col = sheet.cols.indexOf(key.slice(at + 1));
    if (row < 0 || col < 0 || hidden.rows.has(row) || hidden.cols.has(col)) continue;
    const style = sheet.styleAt(row, col);
    if (!style.w && !(typeof raw === 'string' && raw.includes('\n'))) continue;
    const needed = heightForText(engine.textAt(sheet, row, col), style, widths[col]);
    if (needed > heights[row]) heights[row] = needed;
  }
  for (const [key, value] of sheet.props.entries()) {
    if (!key.startsWith('h:') || typeof value !== 'number') continue;
    const row = sheet.rows.indexOf(key.slice(2));
    if (row >= 0) heights[row] = value;
  }
  if (override?.axis === 'row' && override.index < rowCount) heights[override.index] = override.size;
  // Hidden rows and columns take no room at all.
  for (const row of hidden.rows) if (row < rowCount) heights[row] = 0;
  for (const col of hidden.cols) if (col < colCount) widths[col] = 0;

  return { rows: new AxisLayout(heights), cols: new AxisLayout(widths), headerWidth: headerWidthFor(rowCount) };
}

/** The grid's colours, taken from the app's theme where `element` sits. */
export function readTheme(element: Element): GridTheme {
  const styles = getComputedStyle(element);
  const token = (name: string, alpha = 1) => {
    const value = styles.getPropertyValue(name).trim() || '128 128 128';
    return alpha === 1 ? `rgb(${value})` : `rgb(${value} / ${alpha})`;
  };
  const dark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    sheet: dark ? token('--surface-0') : '#ffffff',
    text: token('--text-1'),
    mutedText: token('--text-2'),
    gridLine: dark ? token('--surface-2') : '#e4e4e4',
    header: token('--surface-1'),
    headerLine: dark ? token('--surface-3', 0.7) : token('--surface-3', 0.55),
    headerActive: 'rgb(145 109 254 / 0.22)',
    accent: '#916dfe',
    accentSoft: 'rgb(145 109 254 / 0.13)',
    frozenLine: token('--surface-3'),
    error: dark ? '#ff7b72' : '#c5221f',
  };
}

export interface EditorBox {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  style: CellStyle;
}

/**
 * Where the box for typing sits. With `text` it is shown over its cell and
 * grows with what is typed; without, it waits unseen at the cell, which is
 * where an input method shows its suggestions.
 */
export function placeEditor(view: Viewport, cell: CellPos, style: CellStyle, text: string | null): EditorBox | null {
  if (cell.row >= view.rows.count || cell.col >= view.cols.count) return null;
  const box = rectOnScreen(view, { r1: cell.row, c1: cell.col, r2: cell.row, c2: cell.col });
  if (text === null) {
    return {
      x: Math.max(0, Math.min(box.x, view.width - 4)),
      y: Math.max(0, Math.min(box.y, view.height - 4)),
      width: 1,
      height: 1,
      visible: false,
      style,
    };
  }
  const font = fontOf(style);
  const lines = text.split('\n');
  const widest = Math.max(...lines.map(line => textWidth(line, font)));
  const left = Math.max(view.headerWidth, Math.min(box.x, view.width - 60));
  const top = Math.max(HEADER_HEIGHT, Math.min(box.y, view.height - 30));
  const room = Math.max(60, view.width - left - 4);
  const wanted = Math.max(box.width + 1, widest + CELL_PAD_X * 2 + 12);
  // Text wider than the room left wraps, and the box grows downwards.
  const wrapped = wanted > room
    ? lines.reduce((count, line) => count + Math.max(1, Math.ceil((textWidth(line, font) + 4) / (room - CELL_PAD_X * 2))), 0)
    : lines.length;
  return {
    x: left - 1,
    y: top - 1,
    width: Math.min(wanted, room),
    height: Math.min(Math.max(box.height + 1, wrapped * LINE_HEIGHT + 7), Math.max(40, view.height - top)),
    visible: true,
    style,
  };
}
