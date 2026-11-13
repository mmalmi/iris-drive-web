/**
 * What function implementations share. They signal an error by throwing a
 * SheetError; the caller turns it into the cell's value.
 */
import {
  SheetError,
  compareValues,
  err,
  isError,
  isMatrix,
  textToNumber,
  toBoolean,
  toNumber,
  toText,
  type Matrix,
  type Scalar,
  type Value,
} from '../values';
import type { FnContext } from './evaluate';

export function num(value: Value, ctx: FnContext): number {
  const result = toNumber(ctx.scalar(value));
  if (isError(result)) throw result;
  return result;
}

export function int(value: Value, ctx: FnContext): number {
  return Math.trunc(num(value, ctx));
}

export function text(value: Value, ctx: FnContext): string {
  const scalar = ctx.scalar(value);
  if (isError(scalar)) throw scalar;
  return toText(scalar);
}

export function bool(value: Value, ctx: FnContext): boolean {
  const result = toBoolean(ctx.scalar(value));
  if (isError(result)) throw result;
  return result;
}

/** The value itself, with an error thrown rather than returned. */
export function plain(value: Value, ctx: FnContext): Exclude<Scalar, SheetError> {
  const scalar = ctx.scalar(value);
  if (isError(scalar)) throw scalar;
  return scalar;
}

export function matrix(value: Value): Matrix {
  if (isMatrix(value)) return value;
  return { rows: 1, cols: 1, get: () => value };
}

/**
 * The numbers among the arguments, as SUM counts them: text and TRUE/FALSE
 * inside a range are skipped, while a value typed straight into the formula
 * must be a number.
 */
export function numbers(args: Value[]): number[] {
  const out: number[] = [];
  for (const arg of args) {
    if (isMatrix(arg)) {
      for (let r = 0; r < arg.rows; r += 1) {
        for (let c = 0; c < arg.cols; c += 1) {
          const value = arg.get(r, c);
          if (typeof value === 'number') out.push(value);
          else if (isError(value)) throw value;
        }
      }
    } else if (arg !== null) {
      const number = toNumber(arg);
      if (isError(number)) throw number;
      out.push(number);
    }
  }
  return out;
}

/** Every value among the arguments, ranges unrolled row by row. */
export function flatten(args: Value[]): Scalar[] {
  const out: Scalar[] = [];
  for (const arg of args) {
    if (isMatrix(arg)) {
      for (let r = 0; r < arg.rows; r += 1) {
        for (let c = 0; c < arg.cols; c += 1) out.push(arg.get(r, c));
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

function wildcardPattern(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '~' && i + 1 < pattern.length) {
      i += 1;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '*') {
      source += '.*';
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'is');
}

export function hasWildcard(pattern: string): boolean {
  return /[*?~]/.test(pattern);
}

export function wildcardMatcher(pattern: string): (candidate: string) => boolean {
  const expression = wildcardPattern(pattern);
  return candidate => expression.test(candidate);
}

/**
 * A condition as COUNTIF and SUMIF take it: a value to equal, or text such as
 * ">10", "<>done" or "app*".
 */
export function criterion(condition: Scalar): (value: Scalar) => boolean {
  if (isError(condition)) throw condition;
  let op = '=';
  let operand: Scalar = condition;
  if (typeof condition === 'string') {
    const match = /^(<=|>=|<>|<|>|=)(.*)$/s.exec(condition);
    let rest = condition;
    if (match) {
      op = match[1];
      rest = match[2];
    }
    const asNumber = textToNumber(rest);
    const upper = rest.toUpperCase();
    if (asNumber !== null) operand = asNumber;
    else if (upper === 'TRUE' || upper === 'FALSE') operand = upper === 'TRUE';
    else operand = rest;
  }

  if (op === '=' || op === '<>') {
    let equals: (value: Scalar) => boolean;
    if (typeof operand === 'string') {
      if (operand === '') {
        equals = value => value === null || value === '';
      } else if (hasWildcard(operand)) {
        const matches = wildcardMatcher(operand);
        equals = value => typeof value === 'string' && matches(value);
      } else {
        const wanted = operand.toLowerCase();
        equals = value => typeof value === 'string' && value.toLowerCase() === wanted;
      }
    } else if (typeof operand === 'number') {
      const wanted = operand;
      equals = value => (typeof value === 'number' ? value === wanted : typeof value === 'string' && textToNumber(value) === wanted);
    } else if (operand === null) {
      equals = value => value === null || value === '';
    } else {
      const wanted = operand;
      equals = value => value === wanted;
    }
    return op === '=' ? equals : value => !equals(value);
  }

  const wanted = operand;
  return (value) => {
    if (value === null || isError(value) || typeof value !== typeof wanted) return false;
    const order = compareValues(value, wanted);
    return op === '<' ? order < 0 : op === '>' ? order > 0 : op === '<=' ? order <= 0 : order >= 0;
  };
}

export function requireSameShape(a: Matrix, b: Matrix): void {
  if (a.rows !== b.rows || a.cols !== b.cols) throw err('#VALUE!', 'The ranges must be the same size');
}

export { err };
