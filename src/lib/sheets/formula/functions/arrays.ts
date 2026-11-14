/**
 * Functions whose result is several cells: it fills the cells to the right
 * of and below the formula, as in Google Sheets.
 */
import { ArrayMatrix, compareValues, isError, isMatrix, textToNumber, toBoolean, type Matrix, type Scalar, type Value } from '../../values';
import { defineFunction as define, type FnContext } from '../evaluate';
import { bool, err, int, matrix, num, text } from '../helpers';

const MANY = Infinity;
/** The most cells SEQUENCE makes, to keep a typo from filling the memory. */
const MOST_CELLS = 500_000;

function rowsOf(source: Matrix): Scalar[][] {
  const out: Scalar[][] = [];
  for (let r = 0; r < source.rows; r += 1) {
    const row: Scalar[] = [];
    for (let c = 0; c < source.cols; c += 1) row.push(source.get(r, c));
    out.push(row);
  }
  return out;
}

function transposed(rows: Scalar[][]): Scalar[][] {
  const out: Scalar[][] = [];
  for (let c = 0; c < (rows[0]?.length ?? 0); c += 1) out.push(rows.map(row => row[c]));
  return out;
}

/** An optional TRUE/FALSE, false when left out. */
function option(value: Value | undefined, ctx: FnContext, otherwise = false): boolean {
  return value === undefined || value === null ? otherwise : bool(value, ctx);
}

/** What makes two cells the same for UNIQUE: capitals count, an empty cell is empty text. */
function sameKey(value: Scalar): string {
  if (value === null || value === '') return 's:';
  if (isError(value)) return `e:${value.code}`;
  return `${typeof value}:${String(value)}`;
}

define('UNIQUE', {
  min: 1,
  max: 3,
  arrays: true,
  fn: ([rangeArg, byColumnArg, onceArg], ctx) => {
    const byColumn = option(byColumnArg, ctx);
    const exactlyOnce = option(onceArg, ctx);
    const rows = rowsOf(matrix(rangeArg));
    const lines = byColumn ? transposed(rows) : rows;
    const seen = new Map<string, { line: Scalar[]; count: number }>();
    for (const line of lines) {
      const key = JSON.stringify(line.map(sameKey));
      const entry = seen.get(key);
      if (entry) entry.count += 1;
      else seen.set(key, { line, count: 1 });
    }
    const kept = [...seen.values()].filter(entry => !exactlyOnce || entry.count === 1).map(entry => entry.line);
    if (kept.length === 0) throw err('#N/A', `No ${byColumn ? 'column' : 'row'} appears only once`);
    return new ArrayMatrix(byColumn ? transposed(kept) : kept);
  },
});

/** Whether a condition's cell lets its row through: TRUE, or a number other than 0. */
function passes(value: Scalar): boolean {
  if (isError(value) || value === null) return false;
  const truth = toBoolean(value);
  return truth === true;
}

define('FILTER', {
  min: 2,
  max: MANY,
  arrays: true,
  fn: ([rangeArg, ...conditionArgs]) => {
    const source = matrix(rangeArg);
    const conditions = conditionArgs.map(matrix);
    // Conditions are a column as tall as the range, or a row as wide as it.
    const byRow = conditions[0].cols === 1 && conditions[0].rows === source.rows;
    for (const condition of conditions) {
      const fits = byRow
        ? condition.cols === 1 && condition.rows === source.rows
        : condition.rows === 1 && condition.cols === source.cols;
      if (!fits) {
        throw err('#VALUE!', byRow || source.rows > 1
          ? `FILTER needs conditions as tall as its range: ${source.rows} rows and 1 column, not ${condition.rows} by ${condition.cols}`
          : `FILTER needs conditions as wide as its range: 1 row and ${source.cols} columns, not ${condition.rows} by ${condition.cols}`);
      }
    }
    const rows = rowsOf(source);
    if (byRow) {
      const kept = rows.filter((_, r) => conditions.every(condition => passes(condition.get(r, 0))));
      if (kept.length === 0) throw err('#N/A', 'No rows match the conditions');
      return new ArrayMatrix(kept);
    }
    const columns = transposed(rows).filter((_, c) => conditions.every(condition => passes(condition.get(0, c))));
    if (columns.length === 0) throw err('#N/A', 'No columns match the conditions');
    return new ArrayMatrix(transposed(columns));
  },
});

define('SORT', {
  min: 1,
  max: MANY,
  arrays: true,
  fn: ([rangeArg, ...keyArgs], ctx) => {
    const rows = rowsOf(matrix(rangeArg));
    const width = rows[0]?.length ?? 0;
    // Each key is a column of the range by number, or a column of its own as tall as the range.
    const keys: Array<{ at: (index: number) => Scalar; ascending: boolean }> = [];
    if (keyArgs.length === 0) keys.push({ at: index => rows[index][0], ascending: true });
    for (let i = 0; i < keyArgs.length; i += 2) {
      const keyArg = keyArgs[i];
      const ascending = option(keyArgs[i + 1], ctx, true);
      if (isMatrix(keyArg) && (keyArg.rows > 1 || keyArg.cols > 1)) {
        if (keyArg.cols !== 1 || keyArg.rows !== rows.length) throw err('#VALUE!', `A column to sort by must be ${rows.length} rows tall`);
        keys.push({ at: index => keyArg.get(index, 0), ascending });
      } else {
        const column = int(keyArg, ctx);
        if (column < 1 || column > width) throw err('#VALUE!', `The range has columns 1 to ${width}, not ${column}`);
        keys.push({ at: index => rows[index][column - 1], ascending });
      }
    }
    const order = rows.map((_, index) => index);
    order.sort((a, b) => {
      for (const { at, ascending } of keys) {
        const x = at(a);
        const y = at(b);
        // Empty cells go last either way.
        const emptyX = x === null || x === '';
        const emptyY = y === null || y === '';
        if (emptyX !== emptyY) return emptyX ? 1 : -1;
        if (emptyX) continue;
        const difference = compareValues(x, y);
        if (difference !== 0) return ascending ? difference : -difference;
      }
      return a - b;
    });
    return new ArrayMatrix(order.map(index => rows[index]));
  },
});

define('SEQUENCE', {
  min: 1,
  max: 4,
  fn: ([rowsArg, colsArg, startArg, stepArg], ctx) => {
    const given = (value: Value | undefined, otherwise: number, whole = false) => {
      if (value === undefined || value === null) return otherwise;
      return whole ? int(value, ctx) : num(value, ctx);
    };
    const rows = given(rowsArg, 1, true);
    const cols = given(colsArg, 1, true);
    const start = given(startArg, 1);
    const step = given(stepArg, 1);
    if (rows < 1 || cols < 1) throw err('#VALUE!', 'SEQUENCE needs at least 1 row and 1 column');
    if (rows * cols > MOST_CELLS) throw err('#NUM!', `SEQUENCE can make at most ${MOST_CELLS.toLocaleString('en')} cells`);
    const out: Scalar[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const row: Scalar[] = [];
      for (let c = 0; c < cols; c += 1) row.push(Number((start + (r * cols + c) * step).toPrecision(15)));
      out.push(row);
    }
    return new ArrayMatrix(out);
  },
});

define('TRANSPOSE', {
  min: 1,
  max: 1,
  arrays: true,
  fn: ([rangeArg]) => {
    const source = matrix(rangeArg);
    if (source.rows === 1 && source.cols === 1) return source.get(0, 0);
    return new ArrayMatrix(transposed(rowsOf(source)));
  },
});

define('SPLIT', {
  min: 2,
  max: 4,
  fn: ([textArg, delimiterArg, eachArg, removeArg], ctx) => {
    const value = text(textArg, ctx);
    const delimiter = text(delimiterArg, ctx);
    if (value === '') throw err('#VALUE!', 'There is no text to split');
    if (delimiter === '') throw err('#VALUE!', 'The separator is empty');
    let parts: string[];
    if (option(eachArg, ctx, true)) {
      // Every character of the separator splits on its own.
      parts = [''];
      for (const char of value) {
        if (delimiter.includes(char)) parts.push('');
        else parts[parts.length - 1] += char;
      }
    } else {
      parts = value.split(delimiter);
    }
    if (option(removeArg, ctx, true)) parts = parts.filter(part => part !== '');
    if (parts.length === 0) return '';
    // Parts that are numbers become numbers, as they would when typed.
    return new ArrayMatrix([parts.map(part => textToNumber(part) ?? part)]);
  },
});

/** Calculates the formula inside cell by cell over whole ranges. */
define('ARRAYFORMULA', { min: 1, max: 1, arrays: true, fn: ([value]) => value });
