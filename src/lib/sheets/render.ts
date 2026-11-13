/** Draws the grid on a canvas: only the cells in view, each frame from scratch. */
import { columnName, type CellPos, type Rect } from './address';
import type { Engine } from './engine';
import { formatGeneral, type NumberLocale } from './format';
import {
  FILL_HANDLE,
  FILTER_BUTTON,
  FILTER_BUTTON_INSET,
  HEADER_HEIGHT,
  TOUCH_FILL,
  TOUCH_FILL_OFFSET,
  TOUCH_HANDLE,
  columnX,
  frozenHeight,
  frozenWidth,
  panesOf,
  rowY,
  touchHandles,
  type Pane,
  type Point,
  type Viewport,
} from './layout';
import { readBorder } from './borders';
import { CELL_PAD_X, FONT_FAMILY, FONT_SIZE, TEXT_PAD_Y, fontOf, fontPx, lineHeightOf, textBottom, textWidth, wrapText } from './cellText';
import type { CellStyle, Sheet } from './model';
import { isError, type Scalar } from './values';

/** How many columns to look left of the view for text that runs into it. */
const OVERFLOW_REACH = 40;

export interface GridTheme {
  sheet: string;
  text: string;
  mutedText: string;
  gridLine: string;
  header: string;
  headerLine: string;
  headerActive: string;
  accent: string;
  accentSoft: string;
  frozenLine: string;
  error: string;
}

/** What rules and comments add to cells: looks, checkboxes, lists and marks. */
export interface CellExtras {
  /** The look of a cell with conditional formats applied. */
  look(row: number, col: number): CellStyle;
  /** A control the cell shows instead of, or beside, its text. */
  control(row: number, col: number): 'checkbox' | 'list' | null;
  /** The cell holds a value its validation does not allow. */
  invalid(row: number, col: number): boolean;
  /** The cell has comments that are not resolved. */
  commented(row: number, col: number): boolean;
  /** Whether any cell has a control or a mark, so drawing can skip looking. */
  any: boolean;
}

export const REF_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#d6336c', '#0c8599'];

export interface GridScene extends Viewport {
  sheet: Sheet;
  engine: Engine;
  selection: Rect;
  active: CellPos;
  /** The cell being typed into; its old content is not drawn. */
  editing: CellPos | null;
  /** Cells that were copied or cut, shown with a dashed border. */
  copied: Rect | null;
  /** Where dragging the corner of the selection would fill to. */
  fillTarget: Rect | null;
  /** Cells the formula being typed refers to. */
  references: Array<{ rect: Rect; color: string }>;
  showHandle: boolean;
  focused: boolean;
  /** False while a formula on another sheet is being typed and this sheet is only pointed at. */
  showSelection: boolean;
  /** Cells to mark, such as those a search found. */
  marks: CellPos[];
  /** The header row of this person's filter: each of its cells gets a button; `active` are the columns that filter. */
  filterHeader: { row: number; c1: number; c2: number; active: ReadonlySet<number> } | null;
  /** True while a filter leaves rows out, which the row numbers then show. */
  filtered: boolean;
  /** Where rows or columns being dragged by their header would be dropped. */
  dropLine: { axis: 'row' | 'col'; position: number } | null;
  /** Handles sized for a finger, after the last touch. */
  touch: boolean;
  /** Conditional formats, checkboxes, lists and comment marks; null when there are none. */
  extras: CellExtras | null;
}

/** A cell's look as drawn: with conditional formats when there are any. */
function lookAt(scene: GridScene, row: number, col: number): CellStyle {
  return scene.extras ? scene.extras.look(row, col) : scene.sheet.styleAt(row, col);
}

/** Room a list's arrow takes at the right of a cell. */
export const LIST_ARROW = 16;
/** Size of a checkbox drawn in a cell. */
export const CHECKBOX = 14;

/**
 * The colour for text without one of its own on a filled cell: dark on a
 * light fill and light on a dark one, whichever theme the reader uses.
 */
function readableOn(fill: string, fallback: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
  if (!match) return fallback;
  const [red, green, blue] = [match[1], match[2], match[3]].map(part => parseInt(part, 16));
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#1a1a1a' : '#ffffff';
}

/** A number with as many digits as fit a width, or null when even its whole part does not. */
function roundedToFit(value: number, width: number, font: string, locale: NumberLocale): string | null {
  for (let digits = 9; digits >= 1; digits -= 1) {
    const text = formatGeneral(Number(value.toPrecision(digits)), locale);
    // Rounding away digits before the decimal point would show a different number.
    if (!text.includes(locale.decimal) && !text.includes('E') && Math.abs(value) >= 10 ** digits) return null;
    if (textWidth(text, font) <= width) return text;
  }
  return null;
}

type Align = 'l' | 'c' | 'r';

function alignOf(style: CellStyle, value: Scalar): Align {
  if (style.a) return style.a;
  if (typeof value === 'number') return 'r';
  if (typeof value === 'boolean' || isError(value)) return 'c';
  return 'l';
}

function drawCellText(
  ctx: CanvasRenderingContext2D,
  scene: GridScene,
  theme: GridTheme,
  pane: Pane,
  row: number,
  col: number,
  occupied: (col: number) => boolean,
  /** The block of merged cells the text spreads over, on the canvas. */
  area?: { x: number; y: number; width: number; height: number },
): void {
  const { sheet, engine, cols, rows } = scene;
  if (!area && (rows.size(row) === 0 || cols.size(col) === 0)) return;
  const value = engine.valueAt(sheet, row, col);
  if (value === null || value === '') return;
  const style = lookAt(scene, row, col);
  const control = scene.extras?.control(row, col) ?? null;
  if (control === 'checkbox') return;
  let text = engine.textAt(sheet, row, col);
  if (text === '') return;
  const font = fontOf(style);
  const px = fontPx(style);
  const lineHeight = lineHeightOf(style);
  const align = alignOf(style, value);
  const x = area ? area.x : pane.offsetX + cols.start(col);
  const y = area ? area.y : pane.offsetY + rows.start(row);
  const width = area ? area.width : cols.size(col);
  const height = area ? area.height : rows.size(row);
  if (width <= 0 || height <= 0) return;
  const inner = width - CELL_PAD_X * 2 - (control === 'list' ? LIST_ARROW - 2 : 0);
  const lines = style.w || text.includes('\n') ? wrapText(text, font, style.w ? Math.max(8, inner) : null) : null;

  let clipLeft = x;
  let clipRight = x + width - (control === 'list' ? LIST_ARROW : 0);
  if (!lines) {
    const needed = textWidth(text, font);
    if (needed > inner) {
      if (typeof value === 'number') {
        // A number cut short reads as another number. Without a format it is
        // rounded until it fits; otherwise the cell shows that it does not fit.
        const rounded = engine.formatAt(sheet, row, col) ? null : roundedToFit(value, inner, font, engine.locale);
        text = rounded ?? '#'.repeat(Math.max(1, Math.floor(inner / textWidth('#', font))));
      } else if (!area && !isError(value) && typeof value !== 'boolean') {
        // Long text runs over the empty cells beside it.
        if (align !== 'r') {
          let next = col + 1;
          while (next < cols.count && clipRight < x + CELL_PAD_X + needed + CELL_PAD_X && !occupied(next)) {
            clipRight += cols.size(next);
            next += 1;
          }
        }
        if (align !== 'l') {
          let previous = col - 1;
          while (previous >= 0 && clipLeft > x + width - CELL_PAD_X - needed - CELL_PAD_X && !occupied(previous)) {
            clipLeft -= cols.size(previous);
            previous -= 1;
          }
        }
      }
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(clipLeft, y, clipRight - clipLeft - 1, height - 1);
  ctx.clip();
  if (clipLeft < x || clipRight > x + width) {
    // Cover the grid lines the text runs across.
    ctx.fillStyle = style.bg || theme.sheet;
    ctx.fillRect(clipLeft, y, clipRight - clipLeft - 1, height - 1);
  }
  ctx.font = font;
  ctx.fillStyle = style.c || (isError(value) ? theme.error : style.bg ? readableOn(style.bg, theme.text) : theme.text);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align === 'l' ? 'left' : align === 'r' ? 'right' : 'center';
  const right = x + width - (control === 'list' ? LIST_ARROW - 2 : 0);
  const textX = align === 'l' ? x + CELL_PAD_X : align === 'r' ? right - CELL_PAD_X : (x + right) / 2;
  const shown = lines ?? [text];
  const block = shown.length * lineHeight;
  // Where the first line's baseline sits within its line.
  const inLine = lineHeight - Math.round((lineHeight - px) / 2) - Math.round(px * 0.2);
  const topBaseline = y + 2 + inLine;
  let firstBaseline: number;
  if (block + TEXT_PAD_Y > height || style.va === 't') firstBaseline = topBaseline;
  else if (style.va === 'm') firstBaseline = Math.max(topBaseline, y + Math.round((height - 1 - block) / 2) + inLine);
  else firstBaseline = y + height - textBottom(px) - (shown.length - 1) * lineHeight;
  const thickness = Math.max(1, Math.round(px / 13));
  shown.forEach((line, index) => {
    const baseline = firstBaseline + index * lineHeight;
    ctx.fillText(line, textX, baseline);
    if (style.s || style.u) {
      const lineWidth = textWidth(line, font);
      const left = align === 'l' ? textX : align === 'r' ? textX - lineWidth : textX - lineWidth / 2;
      ctx.fillRect(left, style.s ? Math.round(baseline - px * 0.32) : Math.round(baseline + 2), lineWidth, thickness);
      if (style.s && style.u) ctx.fillRect(left, Math.round(baseline + 2), lineWidth, thickness);
    }
  });
  ctx.restore();
}

/** Draws one border line along a row or column edge. `at` is the grid line's pixel. */
function drawLine(ctx: CanvasRenderingContext2D, value: string, color: string, horizontal: boolean, at: number, from: number, length: number): void {
  const line = readBorder(value);
  if (!line) return;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if (line.kind === 'd' || line.kind === 'o') {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash(line.kind === 'd' ? [4, 2] : [1, 2]);
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(from, at + 0.5);
      ctx.lineTo(from + length, at + 0.5);
    } else {
      ctx.moveTo(at + 0.5, from);
      ctx.lineTo(at + 0.5, from + length);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }
  const thickness = line.kind === 'k' ? 3 : line.kind === 'm' ? 2 : 1;
  const start = at - Math.floor(thickness / 2);
  const reach = from - Math.floor(thickness / 2);
  if (horizontal) ctx.fillRect(reach, start, length + thickness - 1, thickness);
  else ctx.fillRect(start, reach, thickness, length + thickness - 1);
}

function drawBorders(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, pane: Pane): void {
  const { sheet, rows, cols } = scene;
  /**
   * A line without a colour of its own is drawn in the text colour, so it
   * shows in either theme; between two filled cells, in what shows on the fill.
   */
  const colorOf = (value: string, row: number, col: number, otherRow: number, otherCol: number) => {
    const color = readBorder(value)?.color;
    if (color) return color;
    const fill = lookAt(scene, row, col).bg;
    return fill && lookAt(scene, otherRow, otherCol).bg ? readableOn(fill, theme.text) : theme.text;
  };
  const inside = (row: number, col: number, row2: number, col2: number) => {
    const m = sheet.mergeAt(row, col);
    return m !== null && row2 >= m.r1 && row2 <= m.r2 && col2 >= m.c1 && col2 <= m.c2;
  };
  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    if (rows.size(row) === 0) continue;
    const top = pane.offsetY + rows.start(row) - 1;
    const bottom = pane.offsetY + rows.end(row) - 1;
    for (let col = pane.colFrom; col <= pane.colTo; col += 1) {
      if (cols.size(col) === 0) continue;
      const left = pane.offsetX + cols.start(col) - 1;
      const right = pane.offsetX + cols.end(col) - 1;
      const width = cols.size(col);
      const height = rows.size(row);
      const below = sheet.borderAt(row, col, 'bb');
      if (below && !inside(row, col, row + 1, col)) drawLine(ctx, below, colorOf(below, row, col, row + 1, col), true, bottom, left, width + 1);
      const after = sheet.borderAt(row, col, 'br');
      if (after && !inside(row, col, row, col + 1)) drawLine(ctx, after, colorOf(after, row, col, row, col + 1), false, right, top, height + 1);
      if (row === pane.rowFrom) {
        const above = sheet.borderAt(row, col, 'bt');
        if (above && !inside(row, col, row - 1, col)) drawLine(ctx, above, colorOf(above, row, col, row - 1, col), true, top, left, width + 1);
      }
      if (col === pane.colFrom) {
        const before = sheet.borderAt(row, col, 'bl');
        if (before && !inside(row, col, row, col - 1)) drawLine(ctx, before, colorOf(before, row, col, row, col - 1), false, left, top, height + 1);
      }
    }
  }
}

function drawPaneCells(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, pane: Pane): void {
  const { sheet, cols, rows, editing } = scene;
  ctx.save();
  ctx.beginPath();
  ctx.rect(pane.x, pane.y, pane.width, pane.height);
  ctx.clip();
  ctx.fillStyle = theme.sheet;
  ctx.fillRect(pane.x, pane.y, pane.width, pane.height);

  // Grid lines, on the last pixel of each row and column.
  ctx.fillStyle = theme.gridLine;
  const right = Math.min(pane.x + pane.width, pane.offsetX + cols.end(pane.colTo));
  const bottom = Math.min(pane.y + pane.height, pane.offsetY + rows.end(pane.rowTo));
  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    if (rows.size(row) > 0) ctx.fillRect(pane.x, pane.offsetY + rows.end(row) - 1, right - pane.x, 1);
  }
  for (let col = pane.colFrom; col <= pane.colTo; col += 1) {
    if (cols.size(col) > 0) ctx.fillRect(pane.offsetX + cols.end(col) - 1, pane.y, 1, bottom - pane.y);
  }

  const merges = sheet.merges().filter(m => m.r1 <= pane.rowTo && m.r2 >= pane.rowFrom && m.c1 <= pane.colTo && m.c2 >= pane.colFrom);
  const merged = (row: number, col: number) => merges.length > 0 && sheet.mergeAt(row, col) !== null;

  // Fills cover the lines around their cell, so a coloured block reads as one.
  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    for (let col = pane.colFrom; col <= pane.colTo; col += 1) {
      const fill = lookAt(scene, row, col).bg;
      if (!fill || rows.size(row) === 0 || cols.size(col) === 0 || merged(row, col)) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(pane.offsetX + cols.start(col) - 1, pane.offsetY + rows.start(row) - 1, cols.size(col) + 1, rows.size(row) + 1);
    }
  }

  // A merged block is one cell: its first cell's fill, no lines inside.
  const areaOf = (m: Rect) => ({
    x: pane.offsetX + cols.start(m.c1),
    y: pane.offsetY + rows.start(m.r1),
    width: cols.end(m.c2) - cols.start(m.c1),
    height: rows.end(m.r2) - rows.start(m.r1),
  });
  for (const m of merges) {
    const area = areaOf(m);
    if (area.width <= 0 || area.height <= 0) continue;
    const fill = lookAt(scene, m.r1, m.c1).bg;
    ctx.fillStyle = fill || theme.sheet;
    if (fill) ctx.fillRect(area.x - 1, area.y - 1, area.width + 1, area.height + 1);
    else ctx.fillRect(area.x, area.y, area.width - 1, area.height - 1);
  }

  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    if (rows.size(row) === 0) continue;
    const occupied = (col: number) => !sheet.isEmpty(row, col) || merged(row, col) || (editing !== null && editing.row === row && editing.col === col);
    // Text from a cell left of the view may run into it.
    let first = pane.colFrom;
    for (let col = pane.colFrom - 1; col >= Math.max(0, pane.colFrom - OVERFLOW_REACH); col -= 1) {
      if (!sheet.isEmpty(row, col)) {
        first = col;
        break;
      }
    }
    let last = pane.colTo;
    for (let col = pane.colTo + 1; col <= Math.min(cols.count - 1, pane.colTo + OVERFLOW_REACH); col += 1) {
      if (!sheet.isEmpty(row, col)) {
        last = col;
        break;
      }
    }
    for (let col = first; col <= last; col += 1) {
      if (editing && editing.row === row && editing.col === col) continue;
      if (sheet.isEmpty(row, col) || merged(row, col)) continue;
      drawCellText(ctx, scene, theme, pane, row, col, occupied);
    }
  }
  for (const m of merges) {
    if (editing && editing.row === m.r1 && editing.col === m.c1) continue;
    if (!sheet.isEmpty(m.r1, m.c1)) drawCellText(ctx, scene, theme, pane, m.r1, m.c1, () => true, areaOf(m));
  }

  if (sheet.hasBorders()) drawBorders(ctx, scene, theme, pane);
  if (scene.extras?.any) drawControls(ctx, scene, theme, pane);

  const header = scene.filterHeader;
  if (header && header.row >= pane.rowFrom && header.row <= pane.rowTo && rows.size(header.row) > 0) {
    for (let col = Math.max(header.c1, pane.colFrom); col <= Math.min(header.c2, pane.colTo); col += 1) {
      if (cols.size(col) < FILTER_BUTTON + FILTER_BUTTON_INSET * 2) continue;
      const x = pane.offsetX + cols.end(col) - 1 - FILTER_BUTTON_INSET - FILTER_BUTTON;
      const y = pane.offsetY + rows.end(header.row) - 1 - FILTER_BUTTON_INSET - FILTER_BUTTON;
      const on = header.active.has(col);
      ctx.fillStyle = on ? theme.accent : theme.header;
      ctx.beginPath();
      ctx.roundRect(x, y, FILTER_BUTTON, FILTER_BUTTON, 3);
      ctx.fill();
      ctx.strokeStyle = on ? theme.accent : theme.headerLine;
      ctx.lineWidth = 1;
      ctx.stroke();
      // Three bars of shrinking width: the usual sign for a filter.
      ctx.fillStyle = on ? '#ffffff' : theme.mutedText;
      [10, 6, 2].forEach((width, index) => ctx.fillRect(x + (FILTER_BUTTON - width) / 2, y + 4 + index * 3.5, width, 1.5));
    }
  }
  ctx.restore();
}

/**
 * Checkboxes, the arrows of cells that offer a list, and the corner marks of
 * comments and of values a validation rule does not allow.
 */
function drawControls(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, pane: Pane, only?: CellPos): void {
  const { sheet, engine, rows, cols, extras, editing } = scene;
  if (!extras) return;
  for (let row = only?.row ?? pane.rowFrom; row <= (only?.row ?? pane.rowTo); row += 1) {
    const height = rows.size(row);
    if (height === 0) continue;
    const y = pane.offsetY + rows.start(row);
    for (let col = only?.col ?? pane.colFrom; col <= (only?.col ?? pane.colTo); col += 1) {
      const width = cols.size(col);
      if (width === 0) continue;
      const merge = sheet.mergeAt(row, col);
      if (merge && (merge.r1 !== row || merge.c1 !== col)) continue;
      const x = pane.offsetX + cols.start(col);
      const blockWidth = merge ? cols.end(merge.c2) - cols.start(col) : width;
      const blockHeight = merge ? rows.end(merge.r2) - rows.start(row) : height;
      const control = extras.control(row, col);
      const typing = editing !== null && editing.row === row && editing.col === col;
      if (control === 'checkbox' && !typing) {
        const value = engine.valueAt(sheet, row, col);
        const on = value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
        const size = Math.min(CHECKBOX, blockHeight - 6, blockWidth - 6);
        if (size >= 8) {
          const style = lookAt(scene, row, col);
          const left = Math.round(x + (style.a === 'l' ? CELL_PAD_X : style.a === 'r' ? blockWidth - CELL_PAD_X - size : (blockWidth - size) / 2));
          const top = Math.round(y + (blockHeight - size) / 2);
          ctx.beginPath();
          ctx.roundRect(left + 0.5, top + 0.5, size - 1, size - 1, 3);
          if (on) {
            ctx.fillStyle = style.c || theme.accent;
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(left + size * 0.25, top + size * 0.52);
            ctx.lineTo(left + size * 0.43, top + size * 0.7);
            ctx.lineTo(left + size * 0.76, top + size * 0.32);
            ctx.stroke();
          } else {
            ctx.strokeStyle = style.c || theme.mutedText;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      } else if (control === 'list' && !typing && blockWidth > LIST_ARROW + 8) {
        // A small arrow at the right, like the one on a choice box.
        const centerX = x + blockWidth - LIST_ARROW / 2 - 2;
        const centerY = y + blockHeight / 2;
        ctx.fillStyle = theme.mutedText;
        ctx.beginPath();
        ctx.moveTo(centerX - 4, centerY - 2);
        ctx.lineTo(centerX + 4, centerY - 2);
        ctx.lineTo(centerX, centerY + 3);
        ctx.closePath();
        ctx.fill();
      }
      const right = x + blockWidth - 1;
      if (extras.invalid(row, col)) {
        ctx.fillStyle = theme.error;
        ctx.beginPath();
        ctx.moveTo(right - 7, y);
        ctx.lineTo(right, y);
        ctx.lineTo(right, y + 7);
        ctx.closePath();
        ctx.fill();
      }
      if (extras.commented(row, col)) {
        ctx.fillStyle = '#f59f00';
        ctx.beginPath();
        ctx.moveTo(right - 8, y);
        ctx.lineTo(right, y);
        ctx.lineTo(right, y + 8);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
}

/** The part of a rectangle of cells that lies in a pane, in canvas pixels, or null. */
function rectInPane(scene: GridScene, pane: Pane, rect: Rect): { x: number; y: number; width: number; height: number } | null {
  const frozenRows = pane.rowFrom < scene.freezeRows;
  const frozenCols = pane.colFrom < scene.freezeCols;
  const r1 = Math.max(rect.r1, frozenRows ? 0 : scene.freezeRows);
  const r2 = Math.min(rect.r2, frozenRows ? scene.freezeRows - 1 : scene.rows.count - 1);
  const c1 = Math.max(rect.c1, frozenCols ? 0 : scene.freezeCols);
  const c2 = Math.min(rect.c2, frozenCols ? scene.freezeCols - 1 : scene.cols.count - 1);
  if (r1 > r2 || c1 > c2) return null;
  const x = pane.offsetX + scene.cols.start(c1);
  const y = pane.offsetY + scene.rows.start(r1);
  return { x, y, width: pane.offsetX + scene.cols.end(c2) - x, height: pane.offsetY + scene.rows.end(r2) - y };
}

function strokeInside(ctx: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }, lineWidth: number): void {
  ctx.lineWidth = lineWidth;
  // The border sits on the grid lines around the cells.
  ctx.strokeRect(box.x - 1 + lineWidth / 2, box.y - 1 + lineWidth / 2, box.width + 1 - lineWidth, box.height + 1 - lineWidth);
}

function drawPaneOverlays(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, pane: Pane): void {
  ctx.save();
  ctx.beginPath();
  // One pixel more on the left and top, where borders sit on the neighbouring grid line.
  ctx.rect(pane.x - 1, pane.y - 1, pane.width + 1, pane.height + 1);
  ctx.clip();

  if (scene.marks.length > 0) {
    ctx.fillStyle = 'rgb(255 204 0 / 0.38)';
    for (const mark of scene.marks) {
      if (mark.row < pane.rowFrom || mark.row > pane.rowTo || mark.col < pane.colFrom || mark.col > pane.colTo) continue;
      const cell = rectInPane(scene, pane, { r1: mark.row, c1: mark.col, r2: mark.row, c2: mark.col });
      if (cell && cell.width > 0 && cell.height > 0) ctx.fillRect(cell.x, cell.y, cell.width - 1, cell.height - 1);
    }
  }

  for (const reference of scene.references) {
    const box = rectInPane(scene, pane, reference.rect);
    if (!box) continue;
    ctx.fillStyle = `${reference.color}1f`;
    ctx.fillRect(box.x, box.y, box.width - 1, box.height - 1);
    ctx.strokeStyle = reference.color;
    ctx.setLineDash([4, 2]);
    strokeInside(ctx, box, 2);
    ctx.setLineDash([]);
  }

  const { selection, active, sheet } = scene;
  const activeRect = sheet.mergeAt(active.row, active.col) ?? { r1: active.row, c1: active.col, r2: active.row, c2: active.col };
  const single = selection.r1 === activeRect.r1 && selection.r2 === activeRect.r2 && selection.c1 === activeRect.c1 && selection.c2 === activeRect.c2;
  const box = scene.showSelection ? rectInPane(scene, pane, selection) : null;
  if (box) {
    if (!single) {
      ctx.fillStyle = theme.accentSoft;
      ctx.fillRect(box.x, box.y, box.width - 1, box.height - 1);
      // The cell that typing goes into stays clear inside the tinted range.
      const activeBox = rectInPane(scene, pane, activeRect);
      if (activeBox) {
        const style = lookAt(scene, active.row, active.col);
        ctx.fillStyle = style.bg || theme.sheet;
        ctx.fillRect(activeBox.x, activeBox.y, activeBox.width - 1, activeBox.height - 1);
        if (!(scene.editing && scene.editing.row === active.row && scene.editing.col === active.col) && !sheet.isEmpty(active.row, active.col)) {
          const many = activeRect.r2 > activeRect.r1 || activeRect.c2 > activeRect.c1;
          drawCellText(ctx, scene, theme, pane, active.row, active.col, () => true, many ? {
            x: pane.offsetX + scene.cols.start(activeRect.c1),
            y: pane.offsetY + scene.rows.start(activeRect.r1),
            width: scene.cols.end(activeRect.c2) - scene.cols.start(activeRect.c1),
            height: scene.rows.end(activeRect.r2) - scene.rows.start(activeRect.r1),
          } : undefined);
        }
        // Its checkbox or list arrow and its marks, which the clearing covered.
        if (scene.extras?.any) drawControls(ctx, scene, theme, pane, { row: activeRect.r1, col: activeRect.c1 });
      }
    }
    ctx.strokeStyle = scene.focused ? theme.accent : theme.mutedText;
    strokeInside(ctx, box, single ? 2 : 1);
    if (!single) {
      const activeBox = rectInPane(scene, pane, activeRect);
      if (activeBox) strokeInside(ctx, activeBox, 2);
    }
  }

  if (scene.fillTarget) {
    const target = rectInPane(scene, pane, scene.fillTarget);
    if (target) {
      ctx.strokeStyle = theme.accent;
      ctx.setLineDash([3, 3]);
      strokeInside(ctx, target, 1);
      ctx.setLineDash([]);
    }
  }

  if (scene.copied) {
    const copied = rectInPane(scene, pane, scene.copied);
    if (copied) {
      ctx.strokeStyle = theme.accent;
      ctx.setLineDash([5, 3]);
      strokeInside(ctx, copied, 2);
      ctx.setLineDash([]);
    }
  }

  if (scene.showHandle && box && !scene.touch) {
    const corner = rectInPane(scene, pane, { r1: selection.r2, c1: selection.c2, r2: selection.r2, c2: selection.c2 });
    if (corner) {
      const x = corner.x + corner.width - 1 - Math.floor(FILL_HANDLE / 2);
      const y = corner.y + corner.height - 1 - Math.floor(FILL_HANDLE / 2);
      ctx.fillStyle = theme.sheet;
      ctx.fillRect(x - 1, y - 1, FILL_HANDLE + 2, FILL_HANDLE + 2);
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x, y, FILL_HANDLE, FILL_HANDLE);
    }
  }
  ctx.restore();
}

/**
 * On a touch screen: round handles at two corners to stretch the selection,
 * and a square under it to fill. Drawn last, so they show over the headers.
 */
function drawTouchHandles(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme): void {
  if (!scene.touch || !scene.showSelection || scene.editing) return;
  const handles = touchHandles(scene, scene.selection);
  const reach = TOUCH_HANDLE / 2;
  const shown = (point: Point | null): point is Point => point !== null
    && point.x >= scene.headerWidth - reach && point.y >= HEADER_HEIGHT - reach
    && point.x <= scene.width + reach && point.y <= scene.height + reach;
  ctx.save();
  for (const point of [handles.start, handles.end]) {
    if (!shown(point)) continue;
    ctx.beginPath();
    ctx.arc(point.x, point.y, reach, 0, Math.PI * 2);
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.sheet;
    ctx.stroke();
  }
  if (scene.showHandle && shown(handles.fill) && handles.fill.y > HEADER_HEIGHT + TOUCH_FILL) {
    // A square tied to the bottom right corner, like the one a mouse pulls, made larger.
    const size = TOUCH_FILL - 2;
    const { x, y } = handles.fill;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const toLeft = handles.end !== null && x < handles.end.x;
    ctx.moveTo(x + (toLeft ? TOUCH_FILL_OFFSET - 6 : 6 - TOUCH_FILL_OFFSET), y - TOUCH_FILL_OFFSET + 6);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = theme.sheet;
    ctx.beginPath();
    ctx.roundRect(x - size / 2 - 2, y - size / 2 - 2, size + 4, size + 4, 4);
    ctx.fill();
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.roundRect(x - size / 2, y - size / 2, size, size, 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawHeaders(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, panes: Pane[]): void {
  const { cols, rows, headerWidth, width, height } = scene;
  const selection = scene.showSelection ? scene.selection : { r1: -1, c1: -1, r2: -1, c2: -1 };
  const allRows = selection.r1 === 0 && selection.r2 === rows.count - 1;
  const allCols = selection.c1 === 0 && selection.c2 === cols.count - 1;
  ctx.font = `${FONT_SIZE - 1}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, width, HEADER_HEIGHT);
  ctx.fillRect(0, 0, headerWidth, height);

  const columnBands = new Map<number, Pane>();
  const rowBands = new Map<number, Pane>();
  for (const pane of panes) {
    columnBands.set(pane.x, pane);
    rowBands.set(pane.y, pane);
  }

  for (const pane of columnBands.values()) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.x, 0, pane.width, HEADER_HEIGHT);
    ctx.clip();
    for (let col = pane.colFrom; col <= pane.colTo; col += 1) {
      const x = pane.offsetX + cols.start(col);
      const size = cols.size(col);
      const selected = col >= selection.c1 && col <= selection.c2;
      if (selected) {
        ctx.fillStyle = allRows ? theme.accent : theme.headerActive;
        ctx.fillRect(x, 0, size, HEADER_HEIGHT);
      }
      // A hidden column leaves a mark between its neighbours.
      ctx.fillStyle = size === 0 ? theme.accent : theme.headerLine;
      ctx.fillRect(x + size - (size === 0 ? 2 : 1), 0, size === 0 ? 3 : 1, HEADER_HEIGHT);
      ctx.fillStyle = selected ? (allRows ? '#ffffff' : theme.text) : theme.mutedText;
      if (size > 14) ctx.fillText(columnName(col), x + size / 2, HEADER_HEIGHT / 2 + 1);
    }
    ctx.restore();
  }

  for (const pane of rowBands.values()) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, pane.y, headerWidth, pane.height);
    ctx.clip();
    for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
      const y = pane.offsetY + rows.start(row);
      const size = rows.size(row);
      const selected = row >= selection.r1 && row <= selection.r2;
      if (selected) {
        ctx.fillStyle = allCols ? theme.accent : theme.headerActive;
        ctx.fillRect(0, y, headerWidth, size);
      }
      const hiddenByHand = size === 0 && !scene.filtered;
      ctx.fillStyle = hiddenByHand ? theme.accent : theme.headerLine;
      ctx.fillRect(0, y + size - (hiddenByHand ? 2 : 1), headerWidth, hiddenByHand ? 3 : 1);
      ctx.fillStyle = selected ? (allCols ? '#ffffff' : theme.text) : scene.filtered ? theme.accent : theme.mutedText;
      if (size > 10) ctx.fillText(String(row + 1), headerWidth / 2, y + size / 2 + 1);
    }
    ctx.restore();
  }

  // The corner, and the lines that part the headers from the cells.
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, headerWidth, HEADER_HEIGHT);
  ctx.fillStyle = theme.headerLine;
  ctx.fillRect(0, HEADER_HEIGHT - 1, width, 1);
  ctx.fillRect(headerWidth - 1, 0, 1, height);

  ctx.fillStyle = theme.frozenLine;
  if (scene.freezeCols > 0) ctx.fillRect(headerWidth + frozenWidth(scene) - 1, 0, 2, height);
  if (scene.freezeRows > 0) ctx.fillRect(0, HEADER_HEIGHT + frozenHeight(scene) - 1, width, 2);
}

export function drawGrid(ctx: CanvasRenderingContext2D, scene: GridScene, theme: GridTheme, pixelRatio: number): void {
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, scene.width, scene.height);
  const panes = panesOf(scene);
  for (const pane of panes) drawPaneCells(ctx, scene, theme, pane);
  for (const pane of panes) drawPaneOverlays(ctx, scene, theme, pane);
  drawHeaders(ctx, scene, theme, panes);
  drawTouchHandles(ctx, scene, theme);
  if (scene.dropLine) {
    const { axis, position } = scene.dropLine;
    ctx.fillStyle = theme.accent;
    if (axis === 'col') {
      const x = position >= scene.cols.count ? columnX(scene, position - 1) + scene.cols.size(position - 1) : columnX(scene, position);
      if (x >= scene.headerWidth - 1) ctx.fillRect(x - 2, 0, 3, scene.height);
    } else {
      const y = position >= scene.rows.count ? rowY(scene, position - 1) + scene.rows.size(position - 1) : rowY(scene, position);
      if (y >= HEADER_HEIGHT - 1) ctx.fillRect(0, y - 2, scene.width, 3);
    }
  }
}
