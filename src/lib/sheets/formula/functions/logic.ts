/** Conditions, checks and choosing between values. */
import { isError, isMatrix, toBoolean, valuesEqual, type Scalar, type Value } from '../../values';
import { defineFunction as define, elementwise, type FnContext } from '../evaluate';
import type { Node } from '../parser';
import { bool, err, int, plain } from '../helpers';

const MANY = Infinity;

/** TRUE/FALSE readings of the arguments; text and empty cells inside ranges are skipped. */
function truths(args: Value[]): boolean[] {
  const out: boolean[] = [];
  for (const arg of args) {
    if (isMatrix(arg)) {
      for (let r = 0; r < arg.rows; r += 1) {
        for (let c = 0; c < arg.cols; c += 1) {
          const value = arg.get(r, c);
          if (isError(value)) throw value;
          if (typeof value === 'boolean') out.push(value);
          else if (typeof value === 'number') out.push(value !== 0);
        }
      }
    } else {
      const value = toBoolean(arg);
      if (isError(value)) throw value;
      out.push(value);
    }
  }
  if (out.length === 0) throw err('#VALUE!', 'There is nothing to test');
  return out;
}

function check(names: string | string[], test: (value: Scalar) => boolean): void {
  define(names, { min: 1, max: 1, fn: ([value], ctx) => test(ctx.scalar(value)) });
}

define('IF', {
  min: 2,
  max: 3,
  lazy: ([condition, whenTrue, whenFalse]: Node[], ctx: FnContext) => {
    const test = ctx.evaluate(condition);
    if (ctx.arrays && isMatrix(test) && (test.rows > 1 || test.cols > 1)) {
      // Inside ARRAYFORMULA: decided cell by cell.
      const yes = ctx.evaluate(whenTrue);
      const no = whenFalse ? ctx.evaluate(whenFalse) : false;
      return elementwise([test, yes, no], ([truth, a, b]) => {
        const chosen = toBoolean(truth);
        return isError(chosen) ? chosen : chosen ? a : b;
      });
    }
    if (bool(test, ctx)) return ctx.evaluate(whenTrue);
    return whenFalse ? ctx.evaluate(whenFalse) : false;
  },
});
define('IFS', {
  min: 2,
  max: MANY,
  lazy: (args, ctx) => {
    if (args.length % 2 !== 0) throw err('#N/A', 'Each condition needs a value');
    for (let i = 0; i < args.length; i += 2) {
      if (bool(ctx.evaluate(args[i]), ctx)) return ctx.evaluate(args[i + 1]);
    }
    throw err('#N/A', 'None of the conditions is true');
  },
});
define('IFERROR', {
  min: 1,
  max: 2,
  lazy: ([value, fallback], ctx) => {
    const result = ctx.evaluate(value);
    if (ctx.arrays && isMatrix(result) && (result.rows > 1 || result.cols > 1)) {
      const other = fallback ? ctx.evaluate(fallback) : '';
      return elementwise([result, other], ([cell, instead]) => (isError(cell) ? instead : cell));
    }
    if (isError(ctx.scalar(result))) return fallback ? ctx.evaluate(fallback) : '';
    return result;
  },
});
define('IFNA', {
  min: 1,
  max: 2,
  lazy: ([value, fallback], ctx) => {
    const result = ctx.evaluate(value);
    if (ctx.arrays && isMatrix(result) && (result.rows > 1 || result.cols > 1)) {
      const other = fallback ? ctx.evaluate(fallback) : '';
      return elementwise([result, other], ([cell, instead]) => (isError(cell) && cell.code === '#N/A' ? instead : cell));
    }
    const scalar = ctx.scalar(result);
    if (isError(scalar) && scalar.code === '#N/A') return fallback ? ctx.evaluate(fallback) : '';
    return result;
  },
});
define('SWITCH', {
  min: 3,
  max: MANY,
  lazy: ([subject, ...cases], ctx) => {
    const value = plain(ctx.evaluate(subject), ctx);
    for (let i = 0; i + 1 < cases.length; i += 2) {
      if (valuesEqual(value, plain(ctx.evaluate(cases[i]), ctx))) return ctx.evaluate(cases[i + 1]);
    }
    if (cases.length % 2 === 1) return ctx.evaluate(cases[cases.length - 1]);
    throw err('#N/A', 'None of the cases matches');
  },
});
define('CHOOSE', {
  min: 2,
  max: MANY,
  lazy: ([index, ...choices], ctx) => {
    const n = int(ctx.evaluate(index), ctx);
    if (n < 1 || n > choices.length) throw err('#NUM!', `There is no choice number ${n}`);
    return ctx.evaluate(choices[n - 1]);
  },
});
define('AND', { min: 1, max: MANY, fn: args => truths(args).every(Boolean) });
define('OR', { min: 1, max: MANY, fn: args => truths(args).some(Boolean) });
define('XOR', { min: 1, max: MANY, fn: args => truths(args).filter(Boolean).length % 2 === 1 });
define('NOT', { min: 1, max: 1, fn: ([value], ctx) => !bool(value, ctx) });
define('TRUE', { min: 0, max: 0, fn: () => true });
define('FALSE', { min: 0, max: 0, fn: () => false });
define('NA', { min: 0, max: 0, fn: () => err('#N/A') });

check('ISBLANK', value => value === null);
check('ISNUMBER', value => typeof value === 'number');
check('ISTEXT', value => typeof value === 'string');
check('ISNONTEXT', value => typeof value !== 'string');
check('ISLOGICAL', value => typeof value === 'boolean');
check('ISERROR', value => isError(value));
check('ISERR', value => isError(value) && value.code !== '#N/A');
check('ISNA', value => isError(value) && value.code === '#N/A');
define('ISEVEN', { min: 1, max: 1, fn: ([value], ctx) => int(value, ctx) % 2 === 0 });
define('ISODD', { min: 1, max: 1, fn: ([value], ctx) => Math.abs(int(value, ctx) % 2) === 1 });
define('ERROR.TYPE', {
  min: 1,
  max: 1,
  fn: ([value], ctx) => {
    const scalar = ctx.scalar(value);
    if (!isError(scalar)) throw err('#N/A', 'That is not an error');
    return { '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7, '#CYCLE!': 8, '#ERROR!': 8 }[scalar.code];
  },
});
