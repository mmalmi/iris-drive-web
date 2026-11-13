/** What the grid component needs worked out before it can draw: sizes and colours. */
import type { Engine } from './engine';
import { AxisLayout, headerWidthFor } from './layout';
import { DEFAULT_ROW_HEIGHT, type Sheet } from './model';
import { heightForText, type GridTheme } from './render';

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
export function buildLayout(sheet: Sheet, engine: Engine, override: SizeOverride | null): GridLayout {
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
    if (row < 0 || col < 0) continue;
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
