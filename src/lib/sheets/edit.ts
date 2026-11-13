/** Typing into cells: from typed text to stored content and back. */
import { editTextOf, parseInput, TEXT_FORMAT } from './format';
import { decodeRaw, encodeText, isFormula, type Book, type CellRaw, type Sheet } from './model';
import { toDisplay, toStored } from './refs';

/** Adds the closing brackets a formula still lacks, as a person would mean them. */
function closeBrackets(formula: string): string {
  let open = 0;
  let quoted = false;
  for (const char of formula) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '(') open += 1;
    else if (!quoted && char === ')') open -= 1;
  }
  return quoted || open <= 0 ? formula : formula + ')'.repeat(open);
}

export interface StoredInput {
  raw: CellRaw | null;
  /** A number format the typed text implies; used when the cell has none. */
  format?: string;
}

/** What to store for text typed into a cell of `sheet`. */
export function inputToStored(text: string, book: Book, sheet: Sheet, currentFormat?: string): StoredInput {
  if (text.startsWith('=') && text.length > 1 && currentFormat !== TEXT_FORMAT) {
    return { raw: toStored(closeBrackets(text), book, sheet) };
  }
  const parsed = parseInput(text, currentFormat);
  if (parsed.value === null) return { raw: null };
  if (typeof parsed.value === 'string') return { raw: parsed.value === '' ? null : encodeText(parsed.value) };
  return { raw: parsed.value, format: parsed.format };
}

/** Stores typed text in a cell, as one undoable step. */
export function writeInput(book: Book, sheet: Sheet, row: number, col: number, text: string): void {
  const style = sheet.styleAt(row, col);
  const { raw, format } = inputToStored(text, book, sheet, style.nf);
  book.transact(() => {
    sheet.setRaw(row, col, raw);
    if (format && !style.nf) sheet.patchStyle({ r1: row, c1: col, r2: row, c2: col }, { nf: format });
  });
}

/** The text to show for editing a cell. */
export function editTextAt(book: Book, sheet: Sheet, row: number, col: number): string {
  const raw = sheet.rawAt(row, col);
  if (raw === undefined) return '';
  if (isFormula(raw)) return toDisplay(raw, book, sheet);
  return editTextOf(decodeRaw(raw), sheet.styleAt(row, col).nf);
}
