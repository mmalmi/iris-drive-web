/** What a cell can hold once it is calculated, and how one kind turns into another. */

export type ErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A'
  | '#CYCLE!'
  | '#ERROR!';

export const ERROR_CODES: ErrorCode[] = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#CYCLE!', '#ERROR!'];

export class SheetError {
  readonly code: ErrorCode;
  /** A sentence for the person reading the cell. */
  readonly message: string;

  constructor(code: ErrorCode, message = '') {
    this.code = code;
    this.message = message;
  }

  toString(): string {
    return this.code;
  }
}

export const err = (code: ErrorCode, message = ''): SheetError => new SheetError(code, message);

/** A single calculated value. `null` is an empty cell. */
export type Scalar = number | string | boolean | SheetError | null;

/** A rectangle of values: a range of cells or the result of a function. */
export interface Matrix {
  readonly rows: number;
  readonly cols: number;
  get(row: number, col: number): Scalar;
}

/** A matrix that is a range of cells, so functions can ask where it is. */
export interface RangeMatrix extends Matrix {
  readonly sheetId: string;
  readonly top: number;
  readonly left: number;
}

export type Value = Scalar | Matrix;

export class ArrayMatrix implements Matrix {
  readonly rows: number;
  readonly cols: number;
  private readonly data: Scalar[][];

  constructor(data: Scalar[][]) {
    this.data = data;
    this.rows = data.length;
    this.cols = data[0]?.length ?? 0;
  }

  get(row: number, col: number): Scalar {
    return this.data[row]?.[col] ?? null;
  }
}

export function isError(value: unknown): value is SheetError {
  return value instanceof SheetError;
}

export function isMatrix(value: Value): value is Matrix {
  return typeof value === 'object' && value !== null && !(value instanceof SheetError);
}

export function isRange(value: Value): value is RangeMatrix {
  return isMatrix(value) && 'sheetId' in value;
}

/** Visits every value of a matrix, row by row. */
export function eachCell(matrix: Matrix, visit: (value: Scalar, row: number, col: number) => void): void {
  for (let row = 0; row < matrix.rows; row += 1) {
    for (let col = 0; col < matrix.cols; col += 1) visit(matrix.get(row, col), row, col);
  }
}

const NUMBER_TEXT = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** Reads text as a plain number, or returns null when it is not one. */
export function textToNumber(text: string): number | null {
  if (!NUMBER_TEXT.test(text)) {
    const percent = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*%\s*$/.exec(text);
    return percent ? Number(percent[1]) / 100 : null;
  }
  return Number(text);
}

export function toNumber(value: Scalar): number | SheetError {
  if (typeof value === 'number') return value;
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (isError(value)) return value;
  const parsed = textToNumber(value);
  return parsed === null ? err('#VALUE!', `"${value}" is text, where a number is needed`) : parsed;
}

export function toText(value: Scalar): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return numberToText(value);
  return value.code;
}

export function toBoolean(value: Scalar): boolean | SheetError {
  if (typeof value === 'boolean') return value;
  if (value === null) return false;
  if (typeof value === 'number') return value !== 0;
  if (isError(value)) return value;
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return err('#VALUE!', `"${value}" is text, where TRUE or FALSE is needed`);
}

/** A number as plain text, without the noise binary fractions leave behind. */
export function numberToText(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const text = String(Number(value.toPrecision(15)));
  if (!text.includes('e')) return text;
  const [mantissa, exponent] = text.split('e');
  return `${mantissa}E${exponent.startsWith('-') ? '' : '+'}${exponent.replace('+', '')}`;
}

/** Order used by comparisons and sorting: numbers, then text, then TRUE/FALSE. */
function rank(value: Scalar): number {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') return 1;
  if (typeof value === 'boolean') return 2;
  return 3;
}

/** Compares two values the way a spreadsheet does. Text ignores case. */
export function compareValues(left: Scalar, right: Scalar): number {
  let a = left;
  let b = right;
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return rank(a) - rank(b);
}

export function valuesEqual(left: Scalar, right: Scalar): boolean {
  return compareValues(left, right) === 0;
}
