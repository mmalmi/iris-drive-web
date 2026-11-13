/** The actions that change a spreadsheet's content, each one undo step. */
import { rectCols, rectRows, type Rect } from './address';
import type { CopiedCells, SheetController } from './controller.svelte';
import { inputToStored } from './edit';
import { planFill } from './fill';
import { changeDecimals, isDateFormat } from './format';
import { cellKey, encodeText, isFormula, MAX_COLS, MAX_ROWS, type CellRaw, type CellStyle, type Sheet, type StylePatch } from './model';
import { transplant } from './refs';
import { CELL_PAD_X, fontOf, textWidth } from './render';
import { moveKeepingRanges } from './structure';
import { parseClipboardTable, parseCsv, writeClipboardTable, writeCsv } from './table';
import { isError } from './values';

function ownStyle(sheet: Sheet, row: number, col: number): CellStyle | undefined {
  const style = sheet.styleAt(row, col);
  return Object.keys(style).length > 0 ? style : undefined;
}

/** Makes the sheet at least `rows` by `cols` large, as far as it may grow. */
function ensureSize(sheet: Sheet, rows: number, cols: number): void {
  if (rows > sheet.rows.length) sheet.insert('row', sheet.rows.length, rows - sheet.rows.length);
  if (cols > sheet.cols.length) sheet.insert('col', sheet.cols.length, cols - sheet.cols.length);
}

function setCellStyle(sheet: Sheet, row: number, col: number, style: CellStyle | undefined): void {
  const rect = { r1: row, c1: col, r2: row, c2: col };
  sheet.clearStyle(rect);
  if (style) sheet.patchStyle(rect, style);
}

// --- Clearing ---

export function clearContents(ctl: SheetController): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  const rect = ctl.selection;
  const rowIds = new Set(sheet.rows.ids.slice(rect.r1, rect.r2 + 1));
  const colIds = new Set(sheet.cols.ids.slice(rect.c1, rect.c2 + 1));
  ctl.book.transact(() => {
    // Looking at the filled cells is quicker than at every cell of a whole column.
    for (const key of [...sheet.cells.keys()]) {
      const at = key.indexOf(':');
      if (rowIds.has(key.slice(0, at)) && colIds.has(key.slice(at + 1))) sheet.cells.delete(key);
    }
  });
}

// --- Clipboard ---

/** Takes the selection for the clipboard and returns the text to put there. */
export function copySelection(ctl: SheetController, cut = false): string {
  const sheet = ctl.sheet;
  const used = sheet.usedRect();
  let rect = ctl.selection;
  // A whole column is copied as far as it is filled, not a thousand empty lines.
  if (ctl.scope !== 'cells') {
    rect = {
      r1: rect.r1,
      c1: rect.c1,
      r2: ctl.scope === 'rows' ? rect.r2 : Math.max(rect.r1, Math.min(rect.r2, used?.r2 ?? 0)),
      c2: ctl.scope === 'cols' ? rect.c2 : Math.max(rect.c1, Math.min(rect.c2, used?.c2 ?? 0)),
    };
  }
  const lines: string[][] = [];
  const cells: CopiedCells['cells'] = [];
  for (let row = rect.r1; row <= rect.r2; row += 1) {
    const line: string[] = [];
    const cellRow: CopiedCells['cells'][number] = [];
    for (let col = rect.c1; col <= rect.c2; col += 1) {
      line.push(ctl.engine.textAt(sheet, row, col));
      cellRow.push({ raw: sheet.rawAt(row, col), style: ownStyle(sheet, row, col) });
    }
    lines.push(line);
    cells.push(cellRow);
  }
  const text = writeClipboardTable(lines);
  ctl.copied = { sheetId: sheet.id, rect, cut: cut && ctl.canEdit, text, lines, cells };
  return text;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * What was just copied as an HTML table, so that word processors and other
 * spreadsheets receive it with its bold, colours and alignment.
 */
export function copiedHtml(ctl: SheetController): string {
  const copied = ctl.copied;
  if (!copied) return '';
  const rows = copied.lines.map((line, r) => {
    const cells = line.map((text, c) => {
      const style = copied.cells[r]?.[c]?.style ?? {};
      const css = [
        style.b ? 'font-weight:bold' : '',
        style.i ? 'font-style:italic' : '',
        style.s || style.u ? `text-decoration:${[style.s ? 'line-through' : '', style.u ? 'underline' : ''].join(' ').trim()}` : '',
        style.c ? `color:${style.c}` : '',
        style.bg ? `background-color:${style.bg}` : '',
        style.a ? `text-align:${style.a === 'l' ? 'left' : style.a === 'r' ? 'right' : 'center'}` : '',
      ].filter(Boolean).join(';');
      return `<td${css ? ` style="${css}"` : ''}>${escapeHtml(text).replace(/\n/g, '<br>')}</td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  });
  return `<table>${rows.join('')}</table>`;
}

/**
 * Pastes clipboard text at the selection. Text we copied ourselves brings
 * its formulas and looks along; anything else is read as typed values.
 */
export function pasteText(ctl: SheetController, text: string, valuesOnly = false): void {
  if (!ctl.canEdit || text === '') return;
  const sheet = ctl.sheet;
  const copied = ctl.copied && ctl.copied.text === text && ctl.book.nameOf(ctl.copied.sheetId) !== undefined ? ctl.copied : null;
  const table = copied ? null : parseClipboardTable(text);
  const sourceRows = copied ? copied.cells.length : (table as string[][]).length;
  const sourceCols = copied ? copied.cells[0].length : Math.max(1, ...(table as string[][]).map(row => row.length));
  if (sourceRows === 0) return;

  const selection = ctl.selection;
  // A selection that is a whole number of copies wide and tall is filled with copies.
  const fits = (have: number, need: number) => (have > need && have % need === 0 ? have : need);
  const rows = ctl.scope === 'cells' || ctl.scope === 'rows' ? fits(rectRows(selection), sourceRows) : sourceRows;
  const cols = ctl.scope === 'cells' || ctl.scope === 'cols' ? fits(rectCols(selection), sourceCols) : sourceCols;
  const target: Rect = { r1: selection.r1, c1: selection.c1, r2: selection.r1 + rows - 1, c2: selection.c1 + cols - 1 };
  if (target.r2 >= MAX_ROWS || target.c2 >= MAX_COLS) {
    ctl.say('That is too large to paste here.');
    return;
  }

  const source = copied ? ctl.book.sheet(copied.sheetId) : null;
  ctl.book.transact(() => {
    ensureSize(sheet, target.r2 + 1, target.c2 + 1);
    if (copied?.cut && source) {
      for (let row = copied.rect.r1; row <= copied.rect.r2; row += 1) {
        for (let col = copied.rect.c1; col <= copied.rect.c2; col += 1) {
          source.setRaw(row, col, null);
          source.clearStyle({ r1: row, c1: col, r2: row, c2: col });
        }
      }
    }
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const row = target.r1 + r;
        const col = target.c1 + c;
        if (copied && source) {
          const from = copied.cells[r % sourceRows][c % sourceCols];
          let raw = from.raw as CellRaw | undefined;
          if (valuesOnly) {
            const value = ctl.engine.valueAt(source, copied.rect.r1 + (r % sourceRows), copied.rect.c1 + (c % sourceCols));
            raw = value === null ? undefined : isError(value) ? value.code : typeof value === 'string' ? encodeText(value) : value;
          } else if (isFormula(raw) && !copied.cut) {
            // The formula reads the cells that lie the same way from its new place.
            raw = transplant(raw, ctl.book, source, sheet, row - (copied.rect.r1 + (r % sourceRows)), col - (copied.rect.c1 + (c % sourceCols)));
          } else if (isFormula(raw) && source !== sheet) {
            raw = transplant(raw, ctl.book, source, sheet, 0, 0);
          }
          sheet.setRaw(row, col, raw ?? null);
          if (!valuesOnly) setCellStyle(sheet, row, col, from.style);
        } else {
          const typed = (table as string[][])[r % sourceRows][c % sourceCols] ?? '';
          const style = sheet.styleAt(row, col);
          const stored = inputToStored(typed, ctl.book, sheet, style.nf);
          sheet.setRaw(row, col, stored.raw);
          if (stored.format && !style.nf) sheet.patchStyle({ r1: row, c1: col, r2: row, c2: col }, { nf: stored.format });
        }
      }
    }
  });
  if (copied?.cut) ctl.copied = null;
  ctl.setSelection({ row: target.r1, col: target.c1 }, { row: target.r2, col: target.c2 });
}

// --- Filling ---

/**
 * Continues the selection into `target`, which holds the selection and
 * extends it up, down, left or right.
 */
export function fillInto(ctl: SheetController, target: Rect): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  const source = ctl.selection;
  const vertical = target.c1 === source.c1 && target.c2 === source.c2;
  const backwards = vertical ? target.r1 < source.r1 : target.c1 < source.c1;
  const count = vertical
    ? (backwards ? source.r1 - target.r1 : target.r2 - source.r2)
    : (backwards ? source.c1 - target.c1 : target.c2 - source.c2);
  if (count <= 0) return;
  const lanes = vertical ? rectCols(source) : rectRows(source);
  const length = vertical ? rectRows(source) : rectCols(source);
  ctl.book.transact(() => {
    for (let lane = 0; lane < lanes; lane += 1) {
      const place = (index: number) => (vertical
        ? { row: source.r1 + index, col: source.c1 + lane }
        : { row: source.r1 + lane, col: source.c1 + index });
      const cells = Array.from({ length }, (_unused, index) => {
        const { row, col } = place(index);
        return { raw: sheet.rawAt(row, col), isDate: isDateFormat(ctl.engine.formatAt(sheet, row, col)) };
      });
      planFill(cells, count, backwards).forEach((step, k) => {
        const from = place(step.source);
        const to = place(backwards ? -1 - k : length + k);
        let raw: CellRaw | null = step.value ?? cells[step.source].raw ?? null;
        if (step.value === undefined && isFormula(raw)) raw = transplant(raw, ctl.book, sheet, sheet, to.row - from.row, to.col - from.col);
        sheet.setRaw(to.row, to.col, raw);
        setCellStyle(sheet, to.row, to.col, ownStyle(sheet, from.row, from.col));
      });
    }
  });
  ctl.setSelection({ row: target.r1, col: target.c1 }, { row: target.r2, col: target.c2 }, ctl.active);
}

/** Ctrl+D and Ctrl+R: the first row (or column) of the selection is copied through the rest of it. */
export function fillWithin(ctl: SheetController, direction: 'down' | 'right'): void {
  const rect = ctl.selection;
  if (direction === 'down' ? rect.r1 === rect.r2 : rect.c1 === rect.c2) return;
  const active = ctl.active;
  ctl.setSelection(
    { row: rect.r1, col: rect.c1 },
    direction === 'down' ? { row: rect.r1, col: rect.c2 } : { row: rect.r2, col: rect.c1 },
  );
  fillInto(ctl, rect);
  ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 }, active);
}

/**
 * Double-click on the selection's corner: fills down as far as the column
 * beside it is filled.
 */
export function fillDownToNeighbours(ctl: SheetController): void {
  const sheet = ctl.sheet;
  const rect = ctl.selection;
  let end = rect.r2;
  for (const col of [rect.c1 - 1, rect.c2 + 1]) {
    if (col < 0 || col >= sheet.cols.length) continue;
    let row = rect.r2;
    while (row + 1 < sheet.rows.length && !sheet.isEmpty(row + 1, col)) row += 1;
    end = Math.max(end, row);
  }
  if (end > rect.r2) fillInto(ctl, { ...rect, r2: end });
}

// --- Looks ---

/**
 * How to store a look for the selection. Cells dragged over from the first
 * row to the last are whole columns in all but name, and are stored as such
 * rather than a thousand cells at a time.
 */
function styleScope(ctl: SheetController): 'cells' | 'rows' | 'cols' | 'all' {
  if (ctl.scope !== 'cells') return ctl.scope;
  const rect = ctl.selection;
  const sheet = ctl.sheet;
  const allRows = rect.r1 === 0 && rect.r2 === sheet.rows.length - 1 && sheet.rows.length > 1;
  const allCols = rect.c1 === 0 && rect.c2 === sheet.cols.length - 1 && sheet.cols.length > 1;
  return allRows && allCols ? 'all' : allRows ? 'cols' : allCols ? 'rows' : 'cells';
}

export function applyStyle(ctl: SheetController, patch: StylePatch): void {
  if (!ctl.canEdit) return;
  ctl.sheet.patchStyle(ctl.selection, patch, styleScope(ctl));
}

export function toggleStyle(ctl: SheetController, prop: 'b' | 'i' | 's' | 'u' | 'w'): void {
  applyStyle(ctl, { [prop]: ctl.activeStyle[prop] ? null : 1 });
}

export function clearFormatting(ctl: SheetController): void {
  if (!ctl.canEdit) return;
  ctl.sheet.clearStyle(ctl.selection, styleScope(ctl));
}

export function adjustDecimals(ctl: SheetController, delta: number): void {
  const { row, col } = ctl.active;
  const value = ctl.engine.valueAt(ctl.sheet, row, col);
  const next = changeDecimals(ctl.activeFormat, delta, typeof value === 'number' ? value : 0);
  applyStyle(ctl, { nf: next ?? null });
}

// --- Rows and columns ---

/** The selected rows (or columns), whatever kind of selection it is. */
function span(ctl: SheetController, axis: 'row' | 'col'): { from: number; count: number } {
  const rect = ctl.selection;
  return axis === 'row' ? { from: rect.r1, count: rectRows(rect) } : { from: rect.c1, count: rectCols(rect) };
}

export function insertBeside(ctl: SheetController, axis: 'row' | 'col', after: boolean): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  const { from, count } = span(ctl, axis);
  const at = after ? from + count : from;
  let added = 0;
  ctl.book.transact(() => {
    added = sheet.insert(axis, at, count);
    if (added === 0) return;
    // New rows look like the row they were added next to, so a table keeps its look.
    const model = after ? from + count - 1 : from + added;
    const key = axis === 'row' ? `${sheet.rows.ids[model]}:` : `:${sheet.cols.ids[model]}`;
    const style = sheet.styles.get(key);
    const size = sheet.props.get(`${axis === 'row' ? 'h' : 'w'}:${(axis === 'row' ? sheet.rows : sheet.cols).ids[model]}`);
    for (let index = at; index < at + added; index += 1) {
      const id = (axis === 'row' ? sheet.rows : sheet.cols).ids[index];
      if (style) sheet.styles.set(axis === 'row' ? `${id}:` : `:${id}`, style);
      if (size !== undefined && axis === 'col') sheet.props.set(`w:${id}`, size);
    }
  });
  if (added === 0) {
    ctl.say(axis === 'row' ? 'The sheet cannot have more rows.' : 'The sheet cannot have more columns.');
    return;
  }
  if (axis === 'row') ctl.selectRows(at, at + added - 1);
  else ctl.selectCols(at, at + added - 1);
}

export function deleteSelected(ctl: SheetController, axis: 'row' | 'col'): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  const { from, count } = span(ctl, axis);
  const total = axis === 'row' ? sheet.rows.length : sheet.cols.length;
  if (count >= total) {
    ctl.say(axis === 'row' ? 'A sheet needs at least one row.' : 'A sheet needs at least one column.');
    return;
  }
  sheet.remove(axis, from, count);
  const at = Math.min(from, total - count - 1);
  if (axis === 'row') ctl.selectRows(at, at);
  else ctl.selectCols(at, at);
}

/** Moves the selected rows or columns one place towards the start or the end. */
export function moveSelected(ctl: SheetController, axis: 'row' | 'col', towardsEnd: boolean): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  const { from, count } = span(ctl, axis);
  const total = axis === 'row' ? sheet.rows.length : sheet.cols.length;
  if (towardsEnd ? from + count >= total : from === 0) return;
  moveKeepingRanges(ctl.book, sheet, axis, from, count, towardsEnd ? from + count + 1 : from - 1);
  const at = towardsEnd ? from + 1 : from - 1;
  if (axis === 'row') ctl.selectRows(at, at + count - 1);
  else ctl.selectCols(at, at + count - 1);
  ctl.reveal(axis === 'row' ? at : ctl.active.row, axis === 'col' ? at : ctl.active.col);
}

/** Moves the selected rows or columns so they sit before the one now at `position`. */
export function moveSelectedTo(ctl: SheetController, axis: 'row' | 'col', position: number): void {
  if (!ctl.canEdit) return;
  const { from, count } = span(ctl, axis);
  if (position >= from && position <= from + count) return;
  moveKeepingRanges(ctl.book, ctl.sheet, axis, from, count, position);
  const at = position > from ? position - count : position;
  if (axis === 'row') ctl.selectRows(at, at + count - 1);
  else ctl.selectCols(at, at + count - 1);
}

/** Adds empty rows at the bottom of the sheet. */
export function appendRows(ctl: SheetController, count: number): void {
  if (!ctl.canEdit) return;
  const sheet = ctl.sheet;
  if (sheet.insert('row', sheet.rows.length, count) === 0) ctl.say('The sheet cannot have more rows.');
}

/** The width that shows a column's widest content, or 0 for an empty column. */
function fittingWidth(ctl: SheetController, col: number): number {
  const sheet = ctl.sheet;
  const colId = sheet.cols.ids[col];
  let widest = 0;
  for (const key of sheet.cells.keys()) {
    const at = key.indexOf(':');
    if (key.slice(at + 1) !== colId) continue;
    const row = sheet.rows.indexOf(key.slice(0, at));
    if (row < 0) continue;
    const font = fontOf(sheet.styleAt(row, col));
    for (const line of ctl.engine.textAt(sheet, row, col).split('\n')) widest = Math.max(widest, textWidth(line, font));
  }
  return widest === 0 ? 0 : Math.min(600, Math.ceil(widest) + CELL_PAD_X * 2 + 3);
}

/** Sizes a column to its content; with several whole columns selected, each of them. */
export function autoFitColumn(ctl: SheetController, col: number): void {
  if (!ctl.canEdit) return;
  const rect = ctl.selection;
  const among = ctl.scope === 'cols' && col >= rect.c1 && col <= rect.c2;
  ctl.book.transact(() => {
    for (let index = among ? rect.c1 : col; index <= (among ? rect.c2 : col); index += 1) {
      const width = fittingWidth(ctl, index);
      if (width > 0) ctl.sheet.setColWidth(index, index, width);
    }
  });
}

// --- Sheets ---

export function addSheet(ctl: SheetController): void {
  if (!ctl.canEdit) return;
  ctl.commitEdit();
  const id = ctl.book.addSheet(undefined, undefined, undefined, ctl.sheetId);
  ctl.showSheet(id);
}

export function removeSheet(ctl: SheetController, id: string): void {
  if (!ctl.canEdit || ctl.sheets.length <= 1) return;
  ctl.cancelEdit();
  ctl.book.removeSheet(id);
}

/** A copy of a sheet, placed after it. */
export function duplicateSheet(ctl: SheetController, id: string): void {
  if (!ctl.canEdit) return;
  ctl.commitEdit();
  const source = ctl.book.sheet(id);
  let copyId = '';
  ctl.book.transact(() => {
    copyId = ctl.book.addSheet(ctl.book.freeName(`${ctl.book.nameOf(id) ?? 'Sheet'} copy`), source.rows.length, source.cols.length, id);
    const copy = ctl.book.sheet(copyId);
    copy.rebuildAxes();
    const rowOf = new Map(source.rows.ids.map((rowId, index) => [rowId, copy.rows.ids[index]]));
    const colOf = new Map(source.cols.ids.map((colId, index) => [colId, copy.cols.ids[index]]));
    const mapKey = (key: string) => {
      const at = key.indexOf(':');
      const row = key.slice(0, at);
      const col = key.slice(at + 1);
      const newRow = row ? rowOf.get(row) : '';
      const newCol = col ? colOf.get(col) : '';
      return newRow === undefined || newCol === undefined ? null : `${newRow}:${newCol}`;
    };
    for (const [key, raw] of source.cells.entries()) {
      const mapped = mapKey(key);
      if (mapped) copy.cells.set(mapped, isFormula(raw) ? transplant(raw, ctl.book, source, copy, 0, 0) : raw);
    }
    for (const [key, style] of source.styles.entries()) {
      const mapped = mapKey(key);
      if (mapped) copy.styles.set(mapped, style);
    }
    for (const [key, value] of source.props.entries()) {
      if (key === 'freezeRows' || key === 'freezeCols') copy.props.set(key, value);
      const size = /^([wh]):(.*)$/.exec(key);
      if (!size) continue;
      const id2 = size[1] === 'w' ? colOf.get(size[2]) : rowOf.get(size[2]);
      if (id2 !== undefined) copy.props.set(`${size[1]}:${id2}`, value);
    }
  });
  ctl.showSheet(copyId);
}

// --- Files ---

/** Puts a CSV file's content on a new sheet named after the file. */
export function importCsv(ctl: SheetController, fileName: string, text: string): void {
  if (!ctl.canEdit) return;
  const table = parseCsv(text);
  const rows = table.length;
  const cols = Math.max(1, ...table.map(row => row.length));
  if (rows > MAX_ROWS || cols > MAX_COLS) {
    ctl.say('That file is too large to open as a sheet.');
    return;
  }
  ctl.commitEdit();
  const title = fileName.replace(/\.[^.]+$/, '').slice(0, 60) || 'Imported';
  let id = '';
  ctl.book.transact(() => {
    id = ctl.book.addSheet(ctl.book.freeName(title), Math.max(rows + 50, 100), Math.max(cols + 5, 26), ctl.sheetId);
    const sheet = ctl.book.sheet(id);
    sheet.rebuildAxes();
    table.forEach((line, row) => {
      line.forEach((cell, col) => {
        if (cell === '') return;
        const stored = inputToStored(cell, ctl.book, sheet);
        const key = cellKey(sheet.rows.ids[row], sheet.cols.ids[col]);
        if (stored.raw !== null) sheet.cells.set(key, stored.raw);
        if (stored.format) sheet.styles.set(key, { nf: stored.format });
      });
    });
  });
  ctl.showSheet(id);
}

/** The sheet in view as CSV, with values as they are shown. */
export function exportCsv(ctl: SheetController): string {
  const sheet = ctl.sheet;
  const used = sheet.usedRect();
  const lines: string[][] = [];
  if (used) {
    for (let row = 0; row <= used.r2; row += 1) {
      const line: string[] = [];
      for (let col = 0; col <= used.c2; col += 1) line.push(ctl.engine.textAt(sheet, row, col));
      lines.push(line);
    }
  }
  return writeCsv(lines);
}
