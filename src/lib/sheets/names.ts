/**
 * Named ranges: a word such as "Sales" that stands for cells, usable in
 * formulas (=SUM(Sales)) and in the box that jumps to cells.
 *
 * Kept in the book's map as `nr:<name in lower case>` -> { name, ref }, where
 * `ref` is the range in the stored spelling of formulas, always with its
 * sheet: "[sheetId!$c,$r]:[$c,$r]". It follows its rows and columns as they
 * move, as every stored reference does. A formula keeps the name as typed,
 * so renaming a range leaves formulas that use the old name showing #NAME?.
 * Older builds show #NAME? for formulas that use names and leave them alone.
 */
import { columnName, quoteSheetName, type Rect } from './address';
import { tokenize, writeIdRef, type RefSpec } from './formula';
import { LOCAL_ORIGIN, type Book, type Sheet } from './model';
import { resolveRef } from './refs';
import { SheetError, err } from './values';

export interface NamedRange {
  name: string;
  /** The range in the stored spelling of formulas. */
  ref: string;
}

const PREFIX = 'nr:';
const NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;

/** Why a word cannot be a name, or '' when it can. */
export function nameProblem(name: string): string {
  if (!NAME.test(name)) return 'A name starts with a letter and has only letters, digits, "_" and ".".';
  if (/^[A-Za-z]{1,3}\d{1,7}$/.test(name) || /^R\d*C\d*$/i.test(name)) return 'That reads as a cell, like B7.';
  if (/^(true|false)$/i.test(name)) return 'TRUE and FALSE cannot be names.';
  return '';
}

function isNamed(value: unknown): value is NamedRange {
  const named = value as NamedRange | null;
  return !!named && typeof named.name === 'string' && typeof named.ref === 'string';
}

export function listNames(book: Book): NamedRange[] {
  const out: NamedRange[] = [];
  for (const [key, value] of book.meta.entries()) {
    if (key.startsWith(PREFIX) && isNamed(value)) out.push(value);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findName(book: Book, name: string): NamedRange | null {
  const value = book.meta.get(PREFIX + name.toLowerCase());
  return isNamed(value) ? value : null;
}

/** The stored reference a name stands for. */
export function nameRef(book: Book, name: string): RefSpec | null {
  const named = findName(book, name);
  if (!named) return null;
  const token = tokenize(named.ref, 'id').find(item => item.type === 'ref');
  return token?.ref ?? null;
}

/** The cells a name stands for now, or an error when they were deleted; null for an unknown name. */
export function resolveName(book: Book, name: string): { sheet: Sheet; rect: Rect } | SheetError | null {
  const ref = nameRef(book, name);
  if (!ref || ref.sheet === null) return null;
  if (book.nameOf(ref.sheet) === undefined) return err('#REF!', 'The sheet this name stands for was deleted');
  return resolveRef(ref, book, book.sheet(ref.sheet));
}

/** Gives cells a name, or a name new cells. Returns why not, or ''. */
export function defineName(book: Book, name: string, sheet: Sheet, rect: Rect): string {
  const problem = nameProblem(name);
  if (problem) return problem;
  const a = { col: sheet.cols.ids[rect.c1], row: sheet.rows.ids[rect.r1], absCol: true, absRow: true };
  const b = { col: sheet.cols.ids[rect.c2], row: sheet.rows.ids[rect.r2], absCol: true, absRow: true };
  const single = rect.r1 === rect.r2 && rect.c1 === rect.c2;
  const ref = writeIdRef({ sheet: sheet.id, a, b: single ? null : b, resolved: true });
  book.doc.transact(() => book.meta.set(PREFIX + name.toLowerCase(), { name, ref }), LOCAL_ORIGIN);
  return '';
}

export function removeName(book: Book, name: string): void {
  book.doc.transact(() => book.meta.delete(PREFIX + name.toLowerCase()), LOCAL_ORIGIN);
}

/** How a name's cells are written for people: "Sheet1!B2:B9". */
export function nameText(book: Book, named: NamedRange): string {
  const token = tokenize(named.ref, 'id').find(item => item.type === 'ref');
  const ref = token?.ref;
  if (!ref?.sheet || book.nameOf(ref.sheet) === undefined) return '#REF!';
  const found = resolveRef(ref, book, book.sheet(ref.sheet));
  if (found instanceof SheetError) return '#REF!';
  const { rect } = found;
  const first = `${columnName(rect.c1)}${rect.r1 + 1}`;
  const cells = rect.r1 === rect.r2 && rect.c1 === rect.c2 ? first : `${first}:${columnName(rect.c2)}${rect.r2 + 1}`;
  return `${quoteSheetName(book.nameOf(ref.sheet) ?? '')}!${cells}`;
}
