/** Finding values in tables. */
import { cellName, quoteSheetName } from '../../address';
import { ArrayMatrix, compareValues, isError, isRange, type Matrix, type Scalar, type Value } from '../../values';
import { defineFunction as define, sliceMatrix, type FnContext } from '../evaluate';
import { err, hasWildcard, int, matrix, plain, text, wildcardMatcher } from '../helpers';

/** A row or column of a table as a list. */
function line(source: Matrix): { length: number; at: (index: number) => Scalar; vertical: boolean } {
  const vertical = source.cols === 1 || source.rows > 1;
  if (source.rows > 1 && source.cols > 1) throw err('#N/A', 'The range to search must be a single row or column');
  return {
    length: vertical ? source.rows : source.cols,
    at: index => (vertical ? source.get(index, 0) : source.get(0, index)),
    vertical,
  };
}

function comparable(a: Scalar, b: Scalar): boolean {
  return a !== null && !isError(a) && typeof a === typeof b;
}

/** Position of the first (or last) value equal to `key`; text may use * and ?. */
function findExact(key: Scalar, length: number, at: (index: number) => Scalar, wildcards: boolean, backwards = false): number {
  const matches = wildcards && typeof key === 'string' && hasWildcard(key) ? wildcardMatcher(key) : null;
  for (let step = 0; step < length; step += 1) {
    const index = backwards ? length - 1 - step : step;
    const value = at(index);
    if (matches ? typeof value === 'string' && matches(value) : comparable(value, key) && compareValues(value, key) === 0) return index;
  }
  return -1;
}

/** In values sorted upwards: the last one that is not above `key`. */
function findAtMost(key: Scalar, length: number, at: (index: number) => Scalar): number {
  let found = -1;
  for (let index = 0; index < length; index += 1) {
    const value = at(index);
    if (!comparable(value, key)) continue;
    if (compareValues(value, key) > 0) break;
    found = index;
  }
  return found;
}

/** The closest value on one side of `key`, wherever it is. */
function findNearest(key: Scalar, length: number, at: (index: number) => Scalar, direction: 1 | -1): number {
  let found = -1;
  for (let index = 0; index < length; index += 1) {
    const value = at(index);
    if (!comparable(value, key)) continue;
    const order = compareValues(value, key);
    if (order === 0) return index;
    if (Math.sign(order) !== direction) continue;
    if (found < 0 || compareValues(value, at(found)) * direction < 0) found = index;
  }
  return found;
}

function notFound(key: Scalar): never {
  throw err('#N/A', `Did not find "${isError(key) ? key.code : String(key ?? '')}"`);
}

function tableLookup(vertical: boolean) {
  return ([keyArg, tableArg, indexArg, sortedArg]: Value[], ctx: FnContext): Value => {
    const key = plain(keyArg, ctx);
    const table = matrix(tableArg);
    const index = int(indexArg, ctx);
    const sorted = sortedArg === undefined ? true : Boolean(plain(sortedArg, ctx));
    const width = vertical ? table.cols : table.rows;
    const length = vertical ? table.rows : table.cols;
    if (index < 1) throw err('#VALUE!', 'The index must be 1 or more');
    if (index > width) throw err('#REF!', `The table has only ${width} ${vertical ? 'columns' : 'rows'}`);
    const at = (i: number) => (vertical ? table.get(i, 0) : table.get(0, i));
    const found = sorted ? findAtMost(key, length, at) : findExact(key, length, at, true);
    if (found < 0) notFound(key);
    return vertical ? table.get(found, index - 1) : table.get(index - 1, found);
  };
}

define('VLOOKUP', { min: 3, max: 4, fn: tableLookup(true) });
define('HLOOKUP', { min: 3, max: 4, fn: tableLookup(false) });

define('LOOKUP', {
  min: 2,
  max: 3,
  fn: ([keyArg, searchArg, resultArg], ctx) => {
    const key = plain(keyArg, ctx);
    const search = matrix(searchArg);
    let keys = search;
    let results = resultArg === undefined ? search : matrix(resultArg);
    if (resultArg === undefined && search.rows > 1 && search.cols > 1) {
      // One table: search its first column and answer from its last.
      keys = sliceMatrix(search, 0, 0, search.rows, 1);
      results = sliceMatrix(search, 0, search.cols - 1, search.rows, 1);
    }
    const from = line(keys);
    const found = findAtMost(key, from.length, from.at);
    if (found < 0) notFound(key);
    return line(results).at(found);
  },
});

define('MATCH', {
  min: 2,
  max: 3,
  fn: ([keyArg, rangeArg, typeArg], ctx) => {
    const key = plain(keyArg, ctx);
    const range = line(matrix(rangeArg));
    const type = typeArg === undefined ? 1 : int(typeArg, ctx);
    let found: number;
    if (type === 0) found = findExact(key, range.length, range.at, true);
    else if (type > 0) found = findAtMost(key, range.length, range.at);
    else found = findNearest(key, range.length, range.at, 1);
    if (found < 0) notFound(key);
    return found + 1;
  },
});

function xFind(key: Scalar, range: ReturnType<typeof line>, mode: number, searchMode: number): number {
  const backwards = searchMode < 0;
  if (mode === 2) return findExact(key, range.length, range.at, true, backwards);
  const exact = findExact(key, range.length, range.at, false, backwards);
  if (exact >= 0 || mode === 0) return exact;
  return findNearest(key, range.length, range.at, mode > 0 ? 1 : -1);
}

define('XMATCH', {
  min: 2,
  max: 4,
  fn: ([keyArg, rangeArg, modeArg, searchArg], ctx) => {
    const key = plain(keyArg, ctx);
    const found = xFind(key, line(matrix(rangeArg)), modeArg === undefined ? 0 : int(modeArg, ctx), searchArg === undefined ? 1 : int(searchArg, ctx));
    if (found < 0) notFound(key);
    return found + 1;
  },
});

define('XLOOKUP', {
  min: 3,
  max: 6,
  fn: ([keyArg, lookupArg, resultArg, missingArg, modeArg, searchArg], ctx) => {
    const key = plain(keyArg, ctx);
    const lookup = line(matrix(lookupArg));
    const results = matrix(resultArg);
    const found = xFind(key, lookup, modeArg === undefined || modeArg === null ? 0 : int(modeArg, ctx), searchArg === undefined ? 1 : int(searchArg, ctx));
    if (found < 0) {
      if (missingArg !== undefined && missingArg !== null) return missingArg;
      notFound(key);
    }
    if ((lookup.vertical ? results.rows : results.cols) !== lookup.length) {
      throw err('#VALUE!', 'The range to search and the range to answer from must be the same length');
    }
    return lookup.vertical ? sliceMatrix(results, found, 0, 1, results.cols) : sliceMatrix(results, 0, found, results.rows, 1);
  },
});

define('INDEX', {
  min: 1,
  max: 3,
  fn: ([rangeArg, rowArg, colArg], ctx) => {
    const range = matrix(rangeArg);
    let row = rowArg === undefined || rowArg === null ? 0 : int(rowArg, ctx);
    let col = colArg === undefined || colArg === null ? 0 : int(colArg, ctx);
    // With one number and a single row, the number counts along the row.
    if (colArg === undefined && range.rows === 1 && range.cols > 1) {
      col = row;
      row = 1;
    }
    if (row < 0 || col < 0) throw err('#VALUE!', 'Positions must be 1 or more');
    if (row > range.rows || col > range.cols) throw err('#REF!', 'That position is outside the range');
    if (row > 0 && col > 0) return sliceMatrix(range, row - 1, col - 1, 1, 1);
    if (row > 0) return sliceMatrix(range, row - 1, 0, 1, range.cols);
    if (col > 0) return sliceMatrix(range, 0, col - 1, range.rows, 1);
    return range;
  },
});

// Inside ARRAYFORMULA, ROW and COLUMN of a range give the number of each of its rows or columns.
define('ROW', {
  min: 0,
  max: 1,
  fn: ([ref], ctx) => {
    if (ref === undefined) return ctx.scope.row + 1;
    if (!isRange(ref)) throw err('#VALUE!', 'ROW needs a cell');
    if (ctx.arrays && ref.rows > 1) return new ArrayMatrix(Array.from({ length: ref.rows }, (_unused, index) => [ref.top + index + 1]));
    return ref.top + 1;
  },
});
define('COLUMN', {
  min: 0,
  max: 1,
  fn: ([ref], ctx) => {
    if (ref === undefined) return ctx.scope.col + 1;
    if (!isRange(ref)) throw err('#VALUE!', 'COLUMN needs a cell');
    if (ctx.arrays && ref.cols > 1) return new ArrayMatrix([Array.from({ length: ref.cols }, (_unused, index) => ref.left + index + 1)]);
    return ref.left + 1;
  },
});
define('ROWS', { min: 1, max: 1, fn: ([range]) => matrix(range).rows });
define('COLUMNS', { min: 1, max: 1, fn: ([range]) => matrix(range).cols });
define('ADDRESS', {
  min: 2,
  max: 5,
  fn: ([rowArg, colArg, modeArg, _a1, sheetArg], ctx) => {
    const row = int(rowArg, ctx);
    const col = int(colArg, ctx);
    if (row < 1 || col < 1) throw err('#VALUE!', 'Positions must be 1 or more');
    const mode = modeArg === undefined || modeArg === null ? 1 : int(modeArg, ctx);
    const name = cellName(row - 1, col - 1);
    const letters = name.replace(/\d+$/, '');
    const address = `${mode === 1 || mode === 3 ? '$' : ''}${letters}${mode === 1 || mode === 2 ? '$' : ''}${row}`;
    return sheetArg === undefined ? address : `${quoteSheetName(text(sheetArg, ctx))}!${address}`;
  },
});
