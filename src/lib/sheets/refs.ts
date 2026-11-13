/**
 * Moves formulas between the spelling people type (A1, Costs!B2) and the
 * spelling the document keeps (row and column ids), and works out where a
 * stored reference points now.
 */
import { columnIndex, columnName, quoteSheetName, type Rect } from './address';
import { tokenize, writeIdRef, type RefEnd, type RefSpec } from './formula';
import type { Book, Sheet } from './model';
import { SheetError, err } from './values';

function targetSheet(book: Book, home: Sheet, sheetId: string | null): Sheet | null {
  if (sheetId === null) return home;
  return book.nameOf(sheetId) === undefined ? null : book.sheet(sheetId);
}

/** Where a stored reference points now. */
export function resolveRef(ref: RefSpec, book: Book, home: Sheet): { sheet: Sheet; rect: Rect } | SheetError {
  if (!ref.resolved) return err('#REF!', 'This reference does not point at a cell of this spreadsheet');
  const sheet = targetSheet(book, home, ref.sheet);
  if (!sheet) return err('#REF!', 'The sheet this refers to was deleted');
  const end = ref.b ?? ref.a;
  const gone = () => err('#REF!', 'The cells this refers to were deleted');
  let rows: [number, number] | null;
  let cols: [number, number] | null;
  if (ref.b === null) {
    const row = ref.a.row === null ? -1 : sheet.rows.indexOf(ref.a.row);
    const col = ref.a.col === null ? -1 : sheet.cols.indexOf(ref.a.col);
    if (row < 0 || col < 0) return gone();
    return { sheet, rect: { r1: row, c1: col, r2: row, c2: col } };
  }
  if (ref.a.row === null || end.row === null) rows = sheet.rows.length ? [0, sheet.rows.length - 1] : null;
  else rows = sheet.rows.span(ref.a.row, end.row);
  if (ref.a.col === null || end.col === null) cols = sheet.cols.length ? [0, sheet.cols.length - 1] : null;
  else cols = sheet.cols.span(ref.a.col, end.col);
  if (!rows || !cols) return gone();
  return { sheet, rect: { r1: rows[0], c1: cols[0], r2: rows[1], c2: cols[1] } };
}

function a1End(col: number | null, row: number | null, flags: RefEnd): string {
  return `${flags.absCol ? '$' : ''}${col === null ? '' : columnName(col)}${flags.absRow ? '$' : ''}${row === null ? '' : row + 1}`;
}

/** A stored reference as people read it. */
function displayRef(ref: RefSpec, book: Book, home: Sheet): string {
  const found = resolveRef(ref, book, home);
  if (found instanceof SheetError) return '#REF!';
  const { rect } = found;
  const prefix = ref.sheet === null ? '' : `${quoteSheetName(book.nameOf(ref.sheet) ?? '')}!`;
  if (ref.b === null) return prefix + a1End(rect.c1, rect.r1, ref.a);
  const wholeCols = ref.a.row === null;
  const wholeRows = ref.a.col === null;
  const first = a1End(wholeRows ? null : rect.c1, wholeCols ? null : rect.r1, ref.a);
  const second = a1End(wholeRows ? null : rect.c2, wholeCols ? null : rect.r2, ref.b);
  return `${prefix}${first}:${second}`;
}

/** A typed reference tied to ids, or null when it points outside the spreadsheet. */
function storeRef(ref: RefSpec, book: Book, home: Sheet): string | null {
  let sheet = home;
  let sheetId: string | null = null;
  if (ref.sheet !== null) {
    const info = book.sheetByName(ref.sheet);
    if (!info) return null;
    sheet = book.sheet(info.id);
    sheetId = info.id;
  }
  const idEnd = (end: RefEnd): RefEnd | null => {
    const col = end.col === null ? null : sheet.cols.ids[columnIndex(end.col)];
    const row = end.row === null ? null : sheet.rows.ids[Number(end.row) - 1];
    if (col === undefined || row === undefined) return null;
    return { col, row, absCol: end.absCol, absRow: end.absRow };
  };
  const a = idEnd(ref.a);
  const b = ref.b ? idEnd(ref.b) : null;
  if (!a || (ref.b && !b)) return null;
  return writeIdRef({ sheet: sheetId, a, b, resolved: true });
}

/** A typed formula in the spelling the document keeps. Function names become capitals. */
export function toStored(typed: string, book: Book, home: Sheet): string {
  let out = '=';
  for (const token of tokenize(typed.slice(1), 'a1')) {
    if (token.type === 'ref' && token.ref) out += storeRef(token.ref, book, home) ?? token.text;
    else if (token.type === 'func' || token.type === 'bool') out += token.text.toUpperCase();
    else out += token.text;
  }
  return out;
}

/** A stored formula as people read and edit it. */
export function toDisplay(stored: string, book: Book, home: Sheet): string {
  let out = '=';
  for (const token of tokenize(stored.slice(1), 'id')) {
    out += token.type === 'ref' && token.ref?.resolved ? displayRef(token.ref, book, home) : token.text;
  }
  return out;
}

/**
 * A stored formula as it should read after being copied `rows` down and
 * `cols` right, possibly onto another sheet: references without "$" move
 * along, and those pushed off the edge become #REF!.
 */
export function transplant(stored: string, book: Book, from: Sheet, to: Sheet, rows: number, cols: number): string {
  if (rows === 0 && cols === 0 && from === to) return stored;
  let out = '=';
  for (const token of tokenize(stored.slice(1), 'id')) {
    const ref = token.ref;
    if (token.type !== 'ref' || !ref?.resolved) {
      out += token.text;
      continue;
    }
    const source = targetSheet(book, from, ref.sheet);
    const target = ref.sheet === null ? to : source;
    if (!source || !target) {
      out += token.text;
      continue;
    }
    let lost = false;
    const moveEnd = (end: RefEnd): RefEnd => {
      let col = end.col;
      let row = end.row;
      if (col !== null) {
        const index = source.cols.indexOf(col);
        const moved = index < 0 ? -1 : index + (end.absCol ? 0 : cols);
        col = target.cols.ids[moved] ?? null;
        if (col === null) lost = true;
      }
      if (row !== null) {
        const index = source.rows.indexOf(row);
        const moved = index < 0 ? -1 : index + (end.absRow ? 0 : rows);
        row = target.rows.ids[moved] ?? null;
        if (row === null) lost = true;
      }
      return { col, row, absCol: end.absCol, absRow: end.absRow };
    };
    const a = moveEnd(ref.a);
    const b = ref.b ? moveEnd(ref.b) : null;
    out += lost ? '#REF!' : writeIdRef({ sheet: ref.sheet, a, b, resolved: true });
  }
  return out;
}

/** The reference text for a rectangle, as it is inserted while pointing at cells. */
export function rectReference(rect: Rect, sheet: Sheet, home: Sheet, book: Book): string {
  const prefix = sheet === home ? '' : `${quoteSheetName(book.nameOf(sheet.id) ?? '')}!`;
  const first = `${columnName(rect.c1)}${rect.r1 + 1}`;
  if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return prefix + first;
  if (rect.r1 === 0 && rect.r2 === sheet.rows.length - 1 && sheet.rows.length > 1) {
    return `${prefix}${columnName(rect.c1)}:${columnName(rect.c2)}`;
  }
  if (rect.c1 === 0 && rect.c2 === sheet.cols.length - 1 && sheet.cols.length > 1) {
    return `${prefix}${rect.r1 + 1}:${rect.r2 + 1}`;
  }
  return `${prefix}${first}:${columnName(rect.c2)}${rect.r2 + 1}`;
}
