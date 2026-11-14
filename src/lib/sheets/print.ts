/**
 * The open sheet laid out for paper: the cells in use as one table, with
 * values as the grid shows them, their looks and conditional colours, merged
 * blocks and light gridlines. Rows and columns that are hidden or that a
 * filter leaves out stay out. Frozen rows are the table's head, which the
 * browser repeats at the top of every page; rows are not split by a page
 * break. A wide sheet turns the page, and one wider still is made smaller.
 */
import { escapeHtml } from '../markup';
import { cellCss } from './commands';
import type { SheetController } from './controller.svelte';
import { FONT_FAMILY } from './cellText';
import { cellExtras } from './extras';
import { isError } from './values';

/** Printable width of an A4 or Letter page, in CSS pixels, upright and turned. */
const UPRIGHT_WIDTH = 700;
const TURNED_WIDTH = 960;

const STYLES = `
  .sheet-print table { border-collapse: collapse; table-layout: fixed; font: 10pt ${FONT_FAMILY}; color: #1a1a1a; }
  .sheet-print td, .sheet-print th {
    border: 1px solid #d0d0d0; padding: 2px 5px; overflow: hidden; white-space: nowrap;
    vertical-align: bottom; text-align: left; font-weight: normal; line-height: 1.3;
  }
  .sheet-print td.spill { overflow: visible; }
  .sheet-print tr { break-inside: avoid; page-break-inside: avoid; }
  .sheet-print thead { display: table-header-group; }
  .sheet-print, .sheet-print * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

export function sheetPrintPage(ctl: SheetController): HTMLElement {
  const sheet = ctl.sheet;
  const engine = ctl.engine;
  const used = sheet.usedRect();
  const { rows: hiddenRows, cols: hiddenCols } = ctl.visibility;
  const rows: number[] = [];
  const cols: number[] = [];
  if (used) {
    for (let row = 0; row <= used.r2; row += 1) if (!hiddenRows.has(row)) rows.push(row);
    for (let col = 0; col <= used.c2; col += 1) if (!hiddenCols.has(col)) cols.push(col);
  }
  const extras = cellExtras(sheet, engine);
  const look = (row: number, col: number) => extras ? extras.look(row, col) : sheet.styleAt(row, col);

  // Merged blocks span the rows and columns of theirs that are printed.
  const spans = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const merge of sheet.merges()) {
    const inRows = rows.filter(row => row >= merge.r1 && row <= merge.r2);
    const inCols = cols.filter(col => col >= merge.c1 && col <= merge.c2);
    if (inRows.length === 0 || inCols.length === 0) continue;
    spans.set(`${inRows[0]}:${inCols[0]}`, { rows: inRows.length, cols: inCols.length });
    for (const row of inRows) for (const col of inCols) if (row !== inRows[0] || col !== inCols[0]) covered.add(`${row}:${col}`);
  }

  const text = (row: number, col: number): string => {
    if (extras?.control(row, col) === 'checkbox') return engine.valueAt(sheet, row, col) === true ? '☑' : '☐';
    return engine.textAt(sheet, row, col);
  };

  const cell = (row: number, col: number, index: number, tag: 'td' | 'th'): string => {
    if (covered.has(`${row}:${col}`)) return '';
    const style = look(row, col);
    const value = engine.valueAt(sheet, row, col);
    const shown = text(row, col);
    const css = [cellCss(style)];
    // As in the grid: numbers to the right, true, false and errors in the middle.
    if (!style.a && typeof value === 'number') css.push('text-align:right');
    if (!style.a && (typeof value === 'boolean' || isError(value))) css.push('text-align:center');
    if (shown.includes('\n')) css.push('white-space:pre-wrap');
    const span = spans.get(`${row}:${col}`);
    // Text that is not wrapped runs on over empty cells to its right, as on screen, and past the last column.
    const next = cols[index + 1];
    const spill = !span && !style.w && typeof value === 'string' && (style.a ?? 'l') === 'l'
      && (next === undefined || (text(row, next) === '' && !covered.has(`${row}:${next}`)));
    return `<${tag}${spill ? ' class="spill"' : ''}${span && span.rows > 1 ? ` rowspan="${span.rows}"` : ''}${span && span.cols > 1 ? ` colspan="${span.cols}"` : ''} style="${escapeHtml(css.filter(Boolean).join(';'))}">${escapeHtml(shown)}</${tag}>`;
  };

  const line = (row: number, tag: 'td' | 'th'): string => {
    const height = sheet.rowHeight(row);
    return `<tr${height ? ` style="height:${height}px"` : ''}>${cols.map((col, index) => cell(row, col, index, tag)).join('')}</tr>`;
  };

  const frozen = sheet.freezeRows;
  const head = rows.filter(row => row < frozen);
  const body = rows.filter(row => row >= frozen);
  const widths = cols.map(col => sheet.colWidth(col));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const turned = total > UPRIGHT_WIDTH;
  const zoom = total > TURNED_WIDTH ? Math.max(0.4, TURNED_WIDTH / total) : 1;

  const page = document.createElement('div');
  page.className = 'sheet-print';
  page.dataset.testid = 'sheet-print';
  page.dataset.orientation = turned ? 'landscape' : 'portrait';
  page.innerHTML = `<style>${STYLES}${turned ? '@page { size: landscape; }' : ''}</style>`
    + `<table style="width:${total}px${zoom < 1 ? `;zoom:${zoom.toFixed(3)}` : ''}">`
    + `<colgroup>${widths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`
    + (head.length > 0 ? `<thead>${head.map(row => line(row, 'th')).join('')}</thead>` : '')
    + `<tbody>${body.map(row => line(row, 'td')).join('')}</tbody></table>`;
  return page;
}
