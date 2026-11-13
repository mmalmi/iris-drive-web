/**
 * The fonts of cells and how much room their text takes: for drawing the
 * grid, sizing rows and columns to their text, and the files written out.
 */
import type { CellStyle } from './model';

export const FONT_SIZE = 13;
const LINE_HEIGHT = 17;
export const CELL_PAD_X = 5;
export const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TEXT_BOTTOM = 7;

/** The font size in points when a cell has none of its own. */
export const DEFAULT_POINTS = 10;
/** Room under the last line of text, and above the first. */
export const TEXT_PAD_Y = 7;

/** A cell's font size in pixels. */
export function fontPx(style: CellStyle): number {
  return style.fs ? Math.round(style.fs * 13) / 10 : FONT_SIZE;
}

export function fontOf(style: CellStyle): string {
  return `${style.i ? 'italic ' : ''}${style.b ? '700 ' : ''}${fontPx(style)}px ${FONT_FAMILY}`;
}

/** The distance from one line of a cell's text to the next. */
export function lineHeightOf(style: CellStyle): number {
  return style.fs ? Math.round(fontPx(style) * 1.3) : LINE_HEIGHT;
}

/** Room under the text's baseline when it sits at the bottom of its cell. */
export function textBottom(px: number): number {
  return px === FONT_SIZE ? TEXT_BOTTOM : Math.round(4 + px * 0.22);
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
  if (!style.w && !text.includes('\n') && !style.fs) return 0;
  const lines = style.w || text.includes('\n')
    ? wrapText(text, fontOf(style), style.w ? Math.max(8, columnWidth - CELL_PAD_X * 2) : null)
    : [text];
  const needed = lines.length * lineHeightOf(style) + TEXT_PAD_Y;
  return lines.length > 1 || needed > 24 ? needed : 0;
}
