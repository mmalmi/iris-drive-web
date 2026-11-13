/** Draws the grid on a canvas: only the cells in view, each frame from scratch. */
import { columnName, type CellPos, type Rect } from './address';
import type { Engine } from './engine';
import { formatGeneral } from './format';
import { FILL_HANDLE, FILTER_BUTTON, FILTER_BUTTON_INSET, HEADER_HEIGHT, columnX, frozenHeight, frozenWidth, panesOf, rowY, type Pane, type Viewport } from './layout';
import type { CellStyle, Sheet } from './model';
import { isError, type Scalar } from './values';

export const FONT_SIZE = 13;
export const LINE_HEIGHT = 17;
export const CELL_PAD_X = 5;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TEXT_BOTTOM = 7;
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
}

export function fontOf(style: CellStyle): string {
  return `${style.i ? 'italic ' : ''}${style.b ? '700 ' : ''}${FONT_SIZE}px ${FONT_FAMILY}`;
}

let measuring: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
const wrapCache = new Map<string, string[]>();

function measureContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!measuring) {
    measuring = typeof OffscreenCanvas === 'undefined'
      ? document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      : new OffscreenCanvas(1, 1).getContext('2d') as OffscreenCanvasRenderingContext2D;
  }
  return measuring;
}

export function textWidth(text: string, font: string): number {
  const key = `${font}\n${text}`;
  let width = widthCache.get(key);
  if (width === undefined) {
    const context = measureContext();
    context.font = font;
    width = context.measureText(text).width;
    if (widthCache.size > 20_000) widthCache.clear();
    widthCache.set(key, width);
  }
  return width;
}

/** Breaks text into the lines that fit a width; with no width, only at its own line breaks. */
export function wrapText(text: string, font: string, maxWidth: number | null): string[] {
  if (maxWidth === null) return text.includes('\n') ? text.split('\n') : [text];
  const key = `${font}\n${Math.round(maxWidth)}\n${text}`;
  const cached = wrapCache.get(key);
  if (cached) return cached;
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(?<=\s)/)) {
      if (line !== '' && textWidth((line + word).trimEnd(), font) > maxWidth) {
        lines.push(line.trimEnd());
        line = '';
      }
      // A word wider than the cell is cut where it stops fitting.
      let rest = word;
      while (textWidth(rest.trimEnd(), font) > maxWidth && rest.length > 1) {
        let fits = 1;
        while (fits < rest.length && textWidth(rest.slice(0, fits + 1), font) <= maxWidth) fits += 1;
        lines.push(rest.slice(0, fits));
        rest = rest.slice(fits);
      }
      line += rest;
    }
    lines.push(line.trimEnd());
  }
  if (wrapCache.size > 5_000) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}

/** The height a row needs to show every line of its wrapped cells; 0 when the usual height will do. */
export function heightForText(text: string, style: CellStyle, columnWidth: number): number {
  if (!style.w && !text.includes('\n')) return 0;
  const lines = wrapText(text, fontOf(style), style.w ? Math.max(8, columnWidth - CELL_PAD_X * 2) : null);
  return lines.length > 1 ? lines.length * LINE_HEIGHT + TEXT_BOTTOM : 0;
}

/**
 * The colour for text without one of its own on a filled cell: dark on a
 * light fill and light on a dark one, whichever theme the reader uses.
 */
export function readableOn(fill: string, fallback: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill);
  if (!match) return fallback;
  const [red, green, blue] = [match[1], match[2], match[3]].map(part => parseInt(part, 16));
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#1a1a1a' : '#ffffff';
}

/** A number with as many digits as fit a width, or null when even its whole part does not. */
function roundedToFit(value: number, width: number, font: string): string | null {
  for (let digits = 9; digits >= 1; digits -= 1) {
    const text = formatGeneral(Number(value.toPrecision(digits)));
    // Rounding away digits before the decimal point would show a different number.
    if (!text.includes('.') && !text.includes('E') && Math.abs(value) >= 10 ** digits) return null;
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
): void {
  const { sheet, engine, cols, rows } = scene;
  if (rows.size(row) === 0 || cols.size(col) === 0) return;
  const value = engine.valueAt(sheet, row, col);
  if (value === null || value === '') return;
  const style = sheet.styleAt(row, col);
  let text = engine.textAt(sheet, row, col);
  if (text === '') return;
  const font = fontOf(style);
  const align = alignOf(style, value);
  const x = pane.offsetX + cols.start(col);
  const y = pane.offsetY + rows.start(row);
  const width = cols.size(col);
  const height = rows.size(row);
  const inner = width - CELL_PAD_X * 2;
  const lines = style.w || text.includes('\n') ? wrapText(text, font, style.w ? Math.max(8, inner) : null) : null;

  let clipLeft = x;
  let clipRight = x + width;
  if (!lines) {
    const needed = textWidth(text, font);
    if (needed > inner) {
      if (typeof value === 'number') {
        // A number cut short reads as another number. Without a format it is
        // rounded until it fits; otherwise the cell shows that it does not fit.
        const rounded = engine.formatAt(sheet, row, col) ? null : roundedToFit(value, inner, font);
        text = rounded ?? '#'.repeat(Math.max(1, Math.floor(inner / textWidth('#', font))));
      } else if (!isError(value) && typeof value !== 'boolean') {
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
  const textX = align === 'l' ? x + CELL_PAD_X : align === 'r' ? x + width - CELL_PAD_X : x + width / 2;
  const shown = lines ?? [text];
  const firstBaseline = shown.length * LINE_HEIGHT + TEXT_BOTTOM > height
    ? y + LINE_HEIGHT - 3
    : y + height - TEXT_BOTTOM - (shown.length - 1) * LINE_HEIGHT;
  shown.forEach((line, index) => {
    const baseline = firstBaseline + index * LINE_HEIGHT;
    ctx.fillText(line, textX, baseline);
    if (style.s || style.u) {
      const lineWidth = textWidth(line, font);
      const left = align === 'l' ? textX : align === 'r' ? textX - lineWidth : textX - lineWidth / 2;
      ctx.fillRect(left, style.s ? Math.round(baseline - FONT_SIZE * 0.32) : Math.round(baseline + 2), lineWidth, 1);
      if (style.s && style.u) ctx.fillRect(left, Math.round(baseline + 2), lineWidth, 1);
    }
  });
  ctx.restore();
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

  // Fills cover the lines around their cell, so a coloured block reads as one.
  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    for (let col = pane.colFrom; col <= pane.colTo; col += 1) {
      const fill = sheet.styleAt(row, col).bg;
      if (!fill || rows.size(row) === 0 || cols.size(col) === 0) continue;
      ctx.fillStyle = fill;
      ctx.fillRect(pane.offsetX + cols.start(col) - 1, pane.offsetY + rows.start(row) - 1, cols.size(col) + 1, rows.size(row) + 1);
    }
  }

  for (let row = pane.rowFrom; row <= pane.rowTo; row += 1) {
    if (rows.size(row) === 0) continue;
    const occupied = (col: number) => !sheet.isEmpty(row, col) || (editing !== null && editing.row === row && editing.col === col);
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
      if (sheet.isEmpty(row, col)) continue;
      drawCellText(ctx, scene, theme, pane, row, col, occupied);
    }
  }

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

  const { selection, active } = scene;
  const single = selection.r1 === selection.r2 && selection.c1 === selection.c2;
  const box = scene.showSelection ? rectInPane(scene, pane, selection) : null;
  if (box) {
    if (!single) {
      ctx.fillStyle = theme.accentSoft;
      ctx.fillRect(box.x, box.y, box.width - 1, box.height - 1);
      // The cell that typing goes into stays clear inside the tinted range.
      const activeBox = rectInPane(scene, pane, { r1: active.row, c1: active.col, r2: active.row, c2: active.col });
      if (activeBox) {
        const style = scene.sheet.styleAt(active.row, active.col);
        ctx.fillStyle = style.bg || theme.sheet;
        ctx.fillRect(activeBox.x, activeBox.y, activeBox.width - 1, activeBox.height - 1);
        if (!(scene.editing && scene.editing.row === active.row && scene.editing.col === active.col) && !scene.sheet.isEmpty(active.row, active.col)) {
          drawCellText(ctx, scene, theme, pane, active.row, active.col, () => true);
        }
      }
    }
    ctx.strokeStyle = scene.focused ? theme.accent : theme.mutedText;
    strokeInside(ctx, box, single ? 2 : 1);
    if (!single) {
      const activeBox = rectInPane(scene, pane, { r1: active.row, c1: active.col, r2: active.row, c2: active.col });
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

  if (scene.showHandle && box) {
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
