/**
 * Charts of a range of cells, drawn as SVG. The drawing is a plain string,
 * so the same picture shows on the sheet, goes onto the clipboard and could
 * go into a file.
 */
import { escapeHtml } from '../markup';
import { formatGeneral, formatValue, isDateFormat, type NumberLocale } from './format';
import type { Engine } from './engine';
import type { Sheet } from './model';
import { chartRect, type ChartContent } from './objects';

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
}

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
  /** How the numbers are written, from the first value cell. */
  format: string | undefined;
}

/** Colours of the series, in order, for a light and a dark background (see the data-viz palette). */
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

export interface ChartTheme {
  background: string;
  text: string;
  muted: string;
  grid: string;
  series: string[];
}

export const LIGHT_CHART: ChartTheme = { background: '#ffffff', text: '#0b0b0b', muted: '#52514e', grid: '#e4e3df', series: SERIES_LIGHT };
export const DARK_CHART: ChartTheme = { background: '#1a1a19', text: '#f0efec', muted: '#c3c2b7', grid: '#3a3936', series: SERIES_DARK };

/** At most this many series and points are drawn; the rest would not be readable anyway. */
const MAX_SERIES = 8;
const MAX_POINTS = 500;

function isText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isFinite(Number(value));
}

/**
 * What a chart shows: series from its columns (or rows), labels from the
 * first column (or row) when that holds text, and names from the first row
 * (or column) when that holds text.
 */
export function chartData(sheet: Sheet, engine: Engine, chart: ChartContent): ChartData | null {
  const rect = chartRect(sheet, chart);
  if (!rect) return null;
  const hiddenRows = sheet.hidden('row');
  const hiddenCols = sheet.hidden('col');
  const rows: number[] = [];
  const cols: number[] = [];
  for (let row = rect.r1; row <= rect.r2 && rows.length < MAX_POINTS + 1; row += 1) if (!hiddenRows.has(row)) rows.push(row);
  for (let col = rect.c1; col <= rect.c2 && cols.length < MAX_POINTS + 1; col += 1) if (!hiddenCols.has(col)) cols.push(col);
  // Laid out with one series per column: lines are points, columns are series.
  const lines = chart.byRow ? cols : rows;
  const across = chart.byRow ? rows : cols;
  const at = (line: number, item: number) => (chart.byRow ? engine.valueAt(sheet, item, line) : engine.valueAt(sheet, line, item));
  const text = (line: number, item: number) => (chart.byRow ? engine.textAt(sheet, item, line) : engine.textAt(sheet, line, item));
  if (lines.length === 0 || across.length === 0) return { labels: [], series: [], format: undefined };

  // Names: the first line, when any of its value cells is text.
  const headed = lines.length > 1 && across.some((item, index) => (index > 0 || across.length === 1) && isText(at(lines[0], item)));
  const body = headed ? lines.slice(1) : lines;
  // Labels: the first item of each line, when it is text or a date, or when there are several items.
  const firstFormat = chart.byRow ? engine.formatAt(sheet, across[0], body[0] ?? lines[0]) : engine.formatAt(sheet, body[0] ?? lines[0], across[0]);
  const labelled = across.length > 1 && (body.some(line => isText(at(line, across[0]))) || isDateFormat(firstFormat) || body.every(line => at(line, across[0]) === null));
  const items = labelled ? across.slice(1) : across;
  const labels = body.slice(0, MAX_POINTS).map((line, index) => (labelled ? text(line, across[0]) : String(index + 1)));
  const series = items.slice(0, MAX_SERIES).map((item, index) => ({
    name: headed ? text(lines[0], item) || `Series ${index + 1}` : `Series ${index + 1}`,
    values: body.slice(0, MAX_POINTS).map((line) => {
      const value = at(line, item);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      return null;
    }),
  }));
  const valueFormat = items[0] !== undefined && body[0] !== undefined
    ? (chart.byRow ? engine.formatAt(sheet, items[0], body[0]) : engine.formatAt(sheet, body[0], items[0]))
    : undefined;
  return { labels, series, format: valueFormat };
}

/** A short width guess for text, without measuring: good enough to lay out labels. */
function guessWidth(text: string, size: number): number {
  return text.length * size * 0.56;
}

function cut(text: string, width: number, size: number): string {
  if (guessWidth(text, size) <= width) return text;
  const fits = Math.max(1, Math.floor(width / (size * 0.56)) - 1);
  return `${text.slice(0, fits)}…`;
}

/** Round numbers for an axis from `low` to `high`. */
export function niceTicks(low: number, high: number, count = 5): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (low === high) {
    if (low === 0) return [0, 1];
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  const raw = (high - low) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(candidate => candidate >= raw) ?? raw;
  const first = Math.floor(low / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= high + step * 0.001 && ticks.length < 50; value += step) ticks.push(Number(value.toPrecision(12)));
  if (ticks[ticks.length - 1] < high) ticks.push(Number((ticks[ticks.length - 1] + step).toPrecision(12)));
  return ticks;
}

/**
 * A rounded bar: 4px round at the end away from the baseline, square where
 * it stands on it.
 */
function bar(x: number, y: number, width: number, height: number, end: 'top' | 'bottom' | 'right' | 'left', fill: string, title: string): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.min(4, width / 2, height / 2);
  let d: string;
  if (end === 'top') d = `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
  else if (end === 'bottom') d = `M${x},${y}V${y + height - r}Q${x},${y + height} ${x + r},${y + height}H${x + width - r}Q${x + width},${y + height} ${x + width},${y + height - r}V${y}Z`;
  else if (end === 'right') d = `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
  else d = `M${x + width},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + height - r}Q${x},${y + height} ${x + r},${y + height}H${x + width}Z`;
  return `<path d="${d}" fill="${fill}"><title>${escapeHtml(title)}</title></path>`;
}

export interface ChartPicture {
  width: number;
  height: number;
  theme: ChartTheme;
  locale: NumberLocale;
}

/** The chart as an SVG document. */
export function chartSvg(chart: ChartContent, data: ChartData | null, picture: ChartPicture): string {
  const { width, height, theme, locale } = picture;
  const font = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const parts: string[] = [];
  const write = (value: number) => (data?.format ? formatValue(value, data.format, locale) : formatGeneral(Number(value.toPrecision(10)), locale));
  const color = (index: number) => theme.series[index % theme.series.length];
  let top = 12;
  if (chart.title) {
    parts.push(`<text x="${width / 2}" y="${top + 13}" text-anchor="middle" font-size="14" font-weight="600" fill="${theme.text}">${escapeHtml(cut(chart.title, width - 24, 14))}</text>`);
    top += 26;
  }
  const empty = (message: string) => {
    parts.push(`<text x="${width / 2}" y="${(top + height) / 2}" text-anchor="middle" font-size="12" fill="${theme.muted}">${escapeHtml(message)}</text>`);
  };
  const series = data?.series ?? [];
  const labels = data?.labels ?? [];
  if (!data) empty('The cells this chart showed were deleted');
  else if (series.length === 0 || labels.length === 0 || series.every(s => s.values.every(v => v === null))) empty('Add numbers to the cells to see a chart');
  else if (chart.type === 'pie') {
    const values = series[0].values.map(v => (v !== null && v > 0 ? v : 0));
    const total = values.reduce((sum, v) => sum + v, 0);
    // The legend names the slices.
    const legendWidth = chart.legend && width > 260 ? Math.min(160, width * 0.38) : 0;
    const legendBelow = chart.legend && !legendWidth;
    const shown = labels.map((label, index) => ({ label, index })).filter(item => values[item.index] > 0);
    const below = legendBelow ? Math.min(shown.length, 3) * 18 + 6 : 0;
    const cx = (width - legendWidth) / 2;
    const cy = top + (height - top - 12 - below) / 2;
    const radius = Math.max(8, Math.min(cx - 16, (height - top - 12 - below) / 2 - 4));
    if (total <= 0) empty('A pie shows numbers above zero');
    else {
      let angle = -Math.PI / 2;
      shown.forEach(({ index }, order) => {
        const share = values[index] / total;
        const next = angle + share * Math.PI * 2;
        const large = next - angle > Math.PI ? 1 : 0;
        const point = (a: number) => `${cx + radius * Math.cos(a)},${cy + radius * Math.sin(a)}`;
        const title = `${labels[index]}: ${write(values[index])} (${Math.round(share * 100)}%)`;
        const path = share >= 0.9999
          ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color(order)}"><title>${escapeHtml(title)}</title></circle>`
          : `<path d="M${cx},${cy}L${point(angle)}A${radius},${radius} 0 ${large} 1 ${point(next)}Z" fill="${color(order)}" stroke="${theme.background}" stroke-width="2" stroke-linejoin="round"><title>${escapeHtml(title)}</title></path>`;
        parts.push(path);
        // The share on slices big enough to hold it.
        if (share >= 0.06 && radius > 40) {
          const middle = (angle + next) / 2;
          parts.push(`<text x="${cx + radius * 0.66 * Math.cos(middle)}" y="${cy + radius * 0.66 * Math.sin(middle) + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#ffffff">${Math.round(share * 100)}%</text>`);
        }
        angle = next;
      });
      if (legendWidth) {
        const startY = Math.max(top, cy - (Math.min(shown.length, 12) * 18) / 2);
        shown.slice(0, 12).forEach(({ index }, order) => {
          const y = startY + order * 18;
          parts.push(`<rect x="${width - legendWidth}" y="${y}" width="10" height="10" rx="2" fill="${color(order)}"/>`);
          parts.push(`<text x="${width - legendWidth + 16}" y="${y + 9}" font-size="11" fill="${theme.muted}">${escapeHtml(cut(labels[index], legendWidth - 22, 11))}</text>`);
        });
      } else if (legendBelow) {
        let x = 12;
        let y = height - below;
        shown.forEach(({ index }, order) => {
          const label = cut(labels[index], 120, 11);
          const itemWidth = 16 + guessWidth(label, 11) + 12;
          if (x + itemWidth > width - 8 && x > 12) {
            x = 12;
            y += 18;
          }
          if (y > height - 14) return;
          parts.push(`<rect x="${x}" y="${y}" width="10" height="10" rx="2" fill="${color(order)}"/><text x="${x + 16}" y="${y + 9}" font-size="11" fill="${theme.muted}">${escapeHtml(label)}</text>`);
          x += itemWidth;
        });
      }
    }
  } else {
    const all = series.flatMap(s => s.values).filter((v): v is number => v !== null);
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const low = ticks[0];
    const high = ticks[ticks.length - 1];
    const horizontal = chart.type === 'bar';
    // The legend goes under the plot.
    const showLegend = chart.legend && series.length > 1;
    let legendHeight = 0;
    const legendItems: string[] = [];
    if (showLegend) {
      let x = 12;
      let y = 0;
      series.forEach((s, index) => {
        const label = cut(s.name, 140, 11);
        const itemWidth = 16 + guessWidth(label, 11) + 14;
        if (x + itemWidth > width - 8 && x > 12) {
          x = 12;
          y += 18;
        }
        const mark = chart.type === 'line'
          ? `<line x1="${x}" x2="${x + 12}" y1="${y + 5}" y2="${y + 5}" stroke="${color(index)}" stroke-width="2"/>`
          : `<rect x="${x}" y="${y}" width="10" height="10" rx="2" fill="${color(index)}"/>`;
        legendItems.push(`${mark}<text x="${x + 16}" y="${y + 9}" font-size="11" fill="${theme.muted}">${escapeHtml(label)}</text>`);
        x += itemWidth;
      });
      legendHeight = y + 18 + 8;
    }
    const tickTexts = ticks.map(write);
    const valueRoom = horizontal ? 18 : Math.min(90, Math.max(...tickTexts.map(t => guessWidth(t, 11))) + 10);
    const labelRoom = horizontal ? Math.min(width * 0.3, Math.max(...labels.map(l => guessWidth(l, 11))) + 10) : 20;
    const plot = {
      left: 8 + (horizontal ? labelRoom : valueRoom),
      top: top + 4,
      right: width - 14,
      bottom: height - 8 - legendHeight - (horizontal ? valueRoom : labelRoom),
    };
    if (plot.right - plot.left < 30 || plot.bottom - plot.top < 30) empty('Make the chart larger to see it');
    else {
      const span = high - low || 1;
      const along = horizontal ? plot.bottom - plot.top : plot.right - plot.left;
      const scale = (value: number) => (horizontal
        ? plot.left + ((value - low) / span) * (plot.right - plot.left)
        : plot.bottom - ((value - low) / span) * (plot.bottom - plot.top));
      // Grid lines and values along the value axis, quiet.
      ticks.forEach((tick, index) => {
        const at = scale(tick);
        if (horizontal) {
          parts.push(`<line x1="${at}" x2="${at}" y1="${plot.top}" y2="${plot.bottom}" stroke="${theme.grid}" stroke-width="1"/>`);
          parts.push(`<text x="${at}" y="${plot.bottom + 14}" text-anchor="middle" font-size="11" fill="${theme.muted}">${escapeHtml(tickTexts[index])}</text>`);
        } else {
          parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${at}" y2="${at}" stroke="${theme.grid}" stroke-width="1"/>`);
          parts.push(`<text x="${plot.left - 6}" y="${at + 4}" text-anchor="end" font-size="11" fill="${theme.muted}">${escapeHtml(tickTexts[index])}</text>`);
        }
      });
      const zero = scale(Math.max(low, Math.min(0, high)));
      const band = along / labels.length;
      // Category labels: as many as fit, evenly spread.
      const every = Math.max(1, Math.ceil((horizontal ? 16 : Math.max(...labels.map(l => Math.min(guessWidth(l, 11), 90))) + 8) / band));
      labels.forEach((label, index) => {
        if (index % every !== 0) return;
        const middle = (horizontal ? plot.top : plot.left) + band * (index + 0.5);
        if (horizontal) parts.push(`<text x="${plot.left - 6}" y="${middle + 4}" text-anchor="end" font-size="11" fill="${theme.muted}">${escapeHtml(cut(label, labelRoom - 10, 11))}</text>`);
        else parts.push(`<text x="${middle}" y="${plot.bottom + 15}" text-anchor="middle" font-size="11" fill="${theme.muted}">${escapeHtml(cut(label, band * every - 4, 11))}</text>`);
      });
      if (chart.type === 'line') {
        series.forEach((s, index) => {
          let path = '';
          let pen = false;
          const dots: string[] = [];
          s.values.forEach((value, point) => {
            if (value === null) {
              pen = false;
              return;
            }
            const x = plot.left + band * (point + 0.5);
            const y = scale(value);
            path += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
            pen = true;
            if (labels.length <= 40) dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color(index)}" stroke="${theme.background}" stroke-width="2"><title>${escapeHtml(`${s.name}, ${labels[point]}: ${write(value)}`)}</title></circle>`);
          });
          parts.push(`<path d="${path}" fill="none" stroke="${color(index)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
          parts.push(...dots);
        });
      } else {
        const gap = 2;
        const groupRoom = band * 0.72;
        const barSize = Math.max(1, (groupRoom - gap * (series.length - 1)) / series.length);
        series.forEach((s, index) => {
          s.values.forEach((value, point) => {
            if (value === null || value === 0) return;
            const start = (horizontal ? plot.top : plot.left) + band * point + (band - groupRoom) / 2 + index * (barSize + gap);
            const end = scale(value);
            const title = `${series.length > 1 ? `${s.name}, ` : ''}${labels[point]}: ${write(value)}`;
            if (horizontal) parts.push(bar(Math.min(zero, end), start, Math.abs(end - zero), barSize, value >= 0 ? 'right' : 'left', color(index), title));
            else parts.push(bar(start, Math.min(zero, end), barSize, Math.abs(end - zero), value >= 0 ? 'top' : 'bottom', color(index), title));
          });
        });
      }
      // The baseline, a little stronger than the grid.
      if (horizontal) parts.push(`<line x1="${zero}" x2="${zero}" y1="${plot.top}" y2="${plot.bottom}" stroke="${theme.muted}" stroke-width="1"/>`);
      else parts.push(`<line x1="${plot.left}" x2="${plot.right}" y1="${zero}" y2="${zero}" stroke="${theme.muted}" stroke-width="1"/>`);
      if (showLegend) parts.push(`<g transform="translate(0 ${height - legendHeight})">${legendItems.join('')}</g>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${font}">`
    + `<rect width="${width}" height="${height}" fill="${theme.background}"/>${parts.join('')}</svg>`;
}

/** A picture of the chart, for the clipboard. */
export async function chartPng(svg: string, width: number, height: number): Promise<Blob | null> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.scale(scale, scale);
  context.drawImage(image, 0, 0, width, height);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
