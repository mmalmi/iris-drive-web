/** Calculates a parsed formula. */
import type { Rect } from '../address';
import {
  ArrayMatrix,
  SheetError,
  compareValues,
  err,
  isError,
  isMatrix,
  isRange,
  toNumber,
  toText,
  type Matrix,
  type RangeMatrix,
  type Scalar,
  type Value,
} from '../values';
import type { NumberLocale } from '../format';
import type { Node } from './parser';
import type { RefSpec } from './tokens';

/** What the calculation needs from the spreadsheet around it. */
export interface EvalHost {
  /** Where a reference points now, or the error to show when it points nowhere. */
  resolve(ref: RefSpec, homeSheetId: string): { sheetId: string; rect: Rect } | SheetError;
  cell(sheetId: string, row: number, col: number): Scalar;
  /** Where a named range is, an error when its cells are gone, or null for an unknown name. */
  named?(name: string): { sheetId: string; rect: Rect } | SheetError | null;
  /** How the spreadsheet writes numbers, dates and month names. */
  locale?(): NumberLocale;
  now(): Date;
  random(): number;
}

/** The cell whose formula is being calculated. */
export interface EvalScope {
  sheetId: string;
  row: number;
  col: number;
}

export interface FnContext {
  host: EvalHost;
  scope: EvalScope;
  /** Calculates an argument that was handed over uncalculated. */
  evaluate(node: Node): Value;
  scalar(value: Value): Scalar;
  /** True inside ARRAYFORMULA and other functions that work cell by cell over ranges. */
  readonly arrays: boolean;
}

export interface FnSpec {
  min: number;
  max: number;
  /** Receives calculated arguments. */
  fn?: (args: Value[], ctx: FnContext) => Value;
  /** Receives the arguments uncalculated, to skip the ones it does not need. */
  lazy?: (args: Node[], ctx: FnContext) => Value;
  /** Arguments are calculated cell by cell over whole ranges, as in SUMPRODUCT(A1:A3*B1:B3). */
  arrays?: boolean;
}

export const FUNCTIONS = new Map<string, FnSpec>();

export function defineFunction(names: string | string[], spec: FnSpec): void {
  for (const name of Array.isArray(names) ? names : [names]) FUNCTIONS.set(name, spec);
}

class CellRange implements RangeMatrix {
  readonly sheetId: string;
  readonly top: number;
  readonly left: number;
  readonly rows: number;
  readonly cols: number;
  private readonly host: EvalHost;

  constructor(host: EvalHost, sheetId: string, rect: Rect) {
    this.host = host;
    this.sheetId = sheetId;
    this.top = rect.r1;
    this.left = rect.c1;
    this.rows = rect.r2 - rect.r1 + 1;
    this.cols = rect.c2 - rect.c1 + 1;
  }

  get(row: number, col: number): Scalar {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return null;
    return this.host.cell(this.sheetId, this.top + row, this.left + col);
  }
}

/** A window onto part of another matrix, used by INDEX and the lookups. */
export function sliceMatrix(source: Matrix, top: number, left: number, rows: number, cols: number): Matrix {
  const base = { rows, cols, get: (row: number, col: number) => source.get(top + row, left + col) };
  return isRange(source) ? { ...base, sheetId: source.sheetId, top: source.top + top, left: source.left + left } as RangeMatrix : base;
}

/**
 * Combines values cell by cell. A single value, or a single row or column,
 * stands for every row or column; cells one value lacks are #N/A.
 */
export function elementwise(values: Value[], combine: (cells: Scalar[]) => Scalar): Matrix {
  let rows = 1;
  let cols = 1;
  for (const value of values) {
    if (!isMatrix(value)) continue;
    rows = Math.max(rows, value.rows);
    cols = Math.max(cols, value.cols);
  }
  const at = (value: Value, r: number, c: number): Scalar => {
    if (!isMatrix(value)) return value;
    const row = value.rows === 1 ? 0 : r;
    const col = value.cols === 1 ? 0 : c;
    return row < value.rows && col < value.cols ? value.get(row, col) : err('#N/A');
  };
  const out: Scalar[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: Scalar[] = [];
    for (let c = 0; c < cols; c += 1) row.push(combine(values.map(value => at(value, r, c))));
    out.push(row);
  }
  return new ArrayMatrix(out);
}

function arithmetic(op: string, left: Scalar, right: Scalar): Scalar {
  if (isError(left)) return left;
  if (isError(right)) return right;
  switch (op) {
    case '&':
      return toText(left) + toText(right);
    case '=':
      return compareValues(left, right) === 0;
    case '<>':
      return compareValues(left, right) !== 0;
    case '<':
      return compareValues(left, right) < 0;
    case '>':
      return compareValues(left, right) > 0;
    case '<=':
      return compareValues(left, right) <= 0;
    case '>=':
      return compareValues(left, right) >= 0;
    default:
  }
  const a = toNumber(left);
  if (isError(a)) return a;
  const b = toNumber(right);
  if (isError(b)) return b;
  let result: number;
  switch (op) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '*': result = a * b; break;
    case '/':
      if (b === 0) return err('#DIV/0!', 'Division by zero');
      result = a / b;
      break;
    case '^':
      result = a ** b;
      break;
    default:
      return err('#ERROR!', `Unknown operator ${op}`);
  }
  if (!Number.isFinite(result)) return err('#NUM!', 'The result is not a number that can be shown');
  if (op !== '+' && op !== '-') return result;
  // Sums of decimal fractions pick up noise in the last binary digits:
  // 0.1+0.2 should be 0.3, and 3.3-3.3 nothing at all.
  if (Math.abs(result) < Math.max(Math.abs(a), Math.abs(b)) * 1e-15) return 0;
  return Number(result.toPrecision(15));
}

class Evaluator implements FnContext {
  readonly host: EvalHost;
  readonly scope: EvalScope;
  private arrayDepth = 0;

  constructor(host: EvalHost, scope: EvalScope) {
    this.host = host;
    this.scope = scope;
  }

  get arrays(): boolean {
    return this.arrayDepth > 0;
  }

  evaluate = (node: Node): Value => {
    switch (node.t) {
      case 'num':
      case 'str':
      case 'bool':
      case 'err':
        return node.v;
      case 'empty':
        return null;
      case 'name': {
        const found = this.host.named?.(node.name) ?? null;
        if (found === null) return err('#NAME?', `"${node.name}" is not something this spreadsheet knows`);
        if (isError(found)) return found;
        return new CellRange(this.host, found.sheetId, found.rect);
      }
      case 'ref': {
        const target = this.host.resolve(node.ref, this.scope.sheetId);
        if (isError(target)) return target;
        return new CellRange(this.host, target.sheetId, target.rect);
      }
      case 'un': {
        return this.map1(this.evaluate(node.x), (value) => {
          if (isError(value)) return value;
          const number = toNumber(value);
          if (isError(number)) return number;
          return node.op === '-' ? -number : number;
        });
      }
      case 'pct':
        return this.map1(this.evaluate(node.x), (value) => {
          const number = toNumber(value);
          return isError(number) ? number : number / 100;
        });
      case 'bin': {
        const left = this.evaluate(node.l);
        const right = this.evaluate(node.r);
        if (this.arrayDepth > 0 && (isMatrix(left) || isMatrix(right))) {
          return elementwise([left, right], ([a, b]) => arithmetic(node.op, a, b));
        }
        return arithmetic(node.op, this.scalar(left), this.scalar(right));
      }
      case 'call':
        return this.call(node.name, node.args);
      default:
        return err('#ERROR!');
    }
  };

  /** One value out of a range: the cell in the formula's own row or column, as other spreadsheets pick. */
  scalar = (value: Value): Scalar => {
    if (!isMatrix(value)) return value;
    if (value.rows === 1 && value.cols === 1) return value.get(0, 0);
    if (isRange(value) && value.sheetId === this.scope.sheetId) {
      const row = this.scope.row - value.top;
      const col = this.scope.col - value.left;
      if (value.cols === 1 && row >= 0 && row < value.rows) return value.get(row, 0);
      if (value.rows === 1 && col >= 0 && col < value.cols) return value.get(0, col);
    }
    return value.get(0, 0);
  };

  private map1(value: Value, change: (value: Scalar) => Scalar): Value {
    if (this.arrayDepth > 0 && isMatrix(value) && (value.rows > 1 || value.cols > 1)) {
      const rows: Scalar[][] = [];
      for (let r = 0; r < value.rows; r += 1) {
        const row: Scalar[] = [];
        for (let c = 0; c < value.cols; c += 1) row.push(change(value.get(r, c)));
        rows.push(row);
      }
      return new ArrayMatrix(rows);
    }
    return change(this.scalar(value));
  }

  private call(name: string, args: Node[]): Value {
    const spec = FUNCTIONS.get(name);
    if (!spec) return err('#NAME?', `There is no function called ${name}`);
    if (args.length < spec.min || args.length > spec.max) {
      const wanted = spec.min === spec.max ? `${spec.min}` : spec.max === Infinity ? `at least ${spec.min}` : `${spec.min} to ${spec.max}`;
      return err('#N/A', `${name} takes ${wanted} ${spec.min === 1 && spec.max === 1 ? 'value' : 'values'}, not ${args.length}`);
    }
    if (spec.arrays) this.arrayDepth += 1;
    try {
      if (spec.lazy) return spec.lazy(args, this);
      const values = args.map(this.evaluate);
      return (spec.fn as NonNullable<FnSpec['fn']>)(values, this);
    } catch (error) {
      if (error instanceof SheetError) return error;
      if (error instanceof RangeError) return err('#NUM!', 'The calculation is too large');
      throw error;
    } finally {
      if (spec.arrays) this.arrayDepth -= 1;
    }
  }
}

function finite(result: Scalar): Scalar {
  if (typeof result === 'number' && !Number.isFinite(result)) return err('#NUM!', 'The result is not a number that can be shown');
  return result;
}

/** Calculates a formula for one cell. A range as the result gives its first value. */
export function evaluateFormula(node: Node, host: EvalHost, scope: EvalScope): Scalar {
  const evaluator = new Evaluator(host, scope);
  return finite(evaluator.scalar(evaluator.evaluate(node)));
}

/**
 * Calculates a formula for one cell, keeping a result of several cells
 * whole, as UNIQUE or a range on its own gives, for it to fill the cells
 * beside and below.
 */
export function evaluateFormulaArray(node: Node, host: EvalHost, scope: EvalScope): Scalar | Matrix {
  const evaluator = new Evaluator(host, scope);
  const result = evaluator.evaluate(node);
  if (isMatrix(result) && (result.rows !== 1 || result.cols !== 1)) return result;
  return finite(evaluator.scalar(result));
}
