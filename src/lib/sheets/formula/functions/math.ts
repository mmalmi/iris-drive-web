/** Arithmetic and statistics. */
import { roundTo } from '../../format';
import { isError, isMatrix, type Matrix, type Scalar, type Value } from '../../values';
import { defineFunction as define, type FnContext } from '../evaluate';
import { criterion, err, flatten, int, matrix, num, numbers, requireSameShape } from '../helpers';

const MANY = Infinity;

function unary(names: string | string[], compute: (x: number) => number): void {
  define(names, {
    min: 1,
    max: 1,
    fn: ([x], ctx) => {
      const result = compute(num(x, ctx));
      if (Number.isNaN(result) || !Number.isFinite(result)) throw err('#NUM!', 'That number is outside what this function accepts');
      return result;
    },
  });
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return Number(total.toPrecision(15));
}

function roundDigits(value: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const factor = 10 ** digits;
  if (mode === 'half') return digits >= 0 ? roundTo(value, digits) : Math.sign(value) * Math.round(Math.abs(value) * factor) / factor;
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const stepped = mode === 'up' ? Math.ceil(scaled) : Math.floor(scaled);
  return Math.sign(value) * stepped / factor;
}

function variance(values: number[], wholePopulation: boolean): number {
  const count = values.length - (wholePopulation ? 0 : 1);
  if (count <= 0) throw err('#DIV/0!', 'More numbers are needed to work this out');
  const mean = sum(values) / values.length;
  let total = 0;
  for (const value of values) total += (value - mean) ** 2;
  return total / count;
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) throw err('#NUM!', 'There are no numbers to look at');
  if (fraction < 0 || fraction > 1) throw err('#NUM!', 'The percentile must be between 0 and 1');
  const ordered = sorted(values);
  const position = (ordered.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return ordered[low] + (ordered[high] - ordered[low]) * (position - low);
}

/** Pairs of (range, condition) that every row must meet, as in SUMIFS. */
function matchingCells(pairs: Value[], ctx: FnContext): { rows: number; cols: number; test: (row: number, col: number) => boolean } {
  if (pairs.length % 2 !== 0) throw err('#N/A', 'Each range needs a condition');
  const ranges: Array<{ range: Matrix; test: (value: Scalar) => boolean }> = [];
  for (let i = 0; i < pairs.length; i += 2) {
    ranges.push({ range: matrix(pairs[i]), test: criterion(ctx.scalar(pairs[i + 1])) });
  }
  for (const { range } of ranges) requireSameShape(range, ranges[0].range);
  return {
    rows: ranges[0].range.rows,
    cols: ranges[0].range.cols,
    test: (row, col) => ranges.every(({ range, test }) => test(range.get(row, col))),
  };
}

function conditional(values: Value, pairs: Value[], ctx: FnContext): number[] {
  const source = matrix(values);
  const cells = matchingCells(pairs, ctx);
  const out: number[] = [];
  for (let r = 0; r < cells.rows; r += 1) {
    for (let c = 0; c < cells.cols; c += 1) {
      if (!cells.test(r, c)) continue;
      const value = source.get(r, c);
      if (isError(value)) throw value;
      if (typeof value === 'number') out.push(value);
    }
  }
  return out;
}

/** Zero for an empty list, as other spreadsheets answer. */
function smallest(values: number[]): number {
  let result = values.length ? values[0] : 0;
  for (const value of values) if (value < result) result = value;
  return result;
}

function largest(values: number[]): number {
  let result = values.length ? values[0] : 0;
  for (const value of values) if (value > result) result = value;
  return result;
}

function average(values: number[]): number {
  if (values.length === 0) throw err('#DIV/0!', 'There are no numbers to average');
  return sum(values) / values.length;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) [x, y] = [y, x % y];
  return x;
}

define('SUM', { min: 1, max: MANY, fn: args => sum(numbers(args)) });
define('PRODUCT', { min: 1, max: MANY, fn: args => numbers(args).reduce((product, value) => product * value, 1) });
define('SUMSQ', { min: 1, max: MANY, fn: args => sum(numbers(args).map(value => value * value)) });
define(['AVERAGE', 'AVG'], { min: 1, max: MANY, fn: args => average(numbers(args)) });
define('MIN', { min: 1, max: MANY, fn: args => smallest(numbers(args)) });
define('MAX', { min: 1, max: MANY, fn: args => largest(numbers(args)) });
define('COUNT', {
  min: 1,
  max: MANY,
  fn: args => args.reduce<number>((count, arg) => {
    if (isMatrix(arg)) return count + flatten([arg]).filter(value => typeof value === 'number').length;
    return count + (typeof arg === 'number' || (typeof arg === 'string' && arg.trim() !== '' && !Number.isNaN(Number(arg))) ? 1 : 0);
  }, 0),
});
define('COUNTA', { min: 1, max: MANY, fn: args => flatten(args).filter(value => value !== null).length });
define('COUNTBLANK', { min: 1, max: MANY, fn: args => flatten(args).filter(value => value === null || value === '').length });
define('COUNTUNIQUE', {
  min: 1,
  max: MANY,
  fn: args => new Set(flatten(args).filter(value => value !== null && !isError(value)).map(value => `${typeof value}:${String(value)}`)).size,
});
define('MEDIAN', { min: 1, max: MANY, fn: args => percentile(numbers(args), 0.5) });
define('MODE', {
  min: 1,
  max: MANY,
  fn: (args) => {
    const counts = new Map<number, number>();
    let best: number | null = null;
    for (const value of numbers(args)) {
      const count = (counts.get(value) ?? 0) + 1;
      counts.set(value, count);
      if (count > 1 && (best === null || count > (counts.get(best) ?? 0))) best = value;
    }
    if (best === null) throw err('#N/A', 'No number appears more than once');
    return best;
  },
});
define(['STDEV', 'STDEV.S'], { min: 1, max: MANY, fn: args => Math.sqrt(variance(numbers(args), false)) });
define(['STDEVP', 'STDEV.P'], { min: 1, max: MANY, fn: args => Math.sqrt(variance(numbers(args), true)) });
define(['VAR', 'VAR.S'], { min: 1, max: MANY, fn: args => variance(numbers(args), false) });
define(['VARP', 'VAR.P'], { min: 1, max: MANY, fn: args => variance(numbers(args), true) });
define(['PERCENTILE', 'PERCENTILE.INC'], { min: 2, max: 2, fn: ([values, k], ctx) => percentile(numbers([matrix(values)]), num(k, ctx)) });
define(['QUARTILE', 'QUARTILE.INC'], {
  min: 2,
  max: 2,
  fn: ([values, quart], ctx) => {
    const q = int(quart, ctx);
    if (q < 0 || q > 4) throw err('#NUM!', 'The quartile must be 0, 1, 2, 3 or 4');
    return percentile(numbers([matrix(values)]), q / 4);
  },
});
define('LARGE', {
  min: 2,
  max: 2,
  fn: ([values, k], ctx) => {
    const ordered = sorted(numbers([matrix(values)]));
    const n = int(k, ctx);
    if (n < 1 || n > ordered.length) throw err('#NUM!', `There is no number ${n} in a list of ${ordered.length}`);
    return ordered[ordered.length - n];
  },
});
define('SMALL', {
  min: 2,
  max: 2,
  fn: ([values, k], ctx) => {
    const ordered = sorted(numbers([matrix(values)]));
    const n = int(k, ctx);
    if (n < 1 || n > ordered.length) throw err('#NUM!', `There is no number ${n} in a list of ${ordered.length}`);
    return ordered[n - 1];
  },
});
define(['RANK', 'RANK.EQ'], {
  min: 2,
  max: 3,
  fn: ([value, values, ascending], ctx) => {
    const target = num(value, ctx);
    const all = numbers([matrix(values)]);
    if (!all.includes(target)) throw err('#N/A', 'The number is not in the list');
    const up = ascending !== undefined && num(ascending, ctx) !== 0;
    return 1 + all.filter(other => (up ? other < target : other > target)).length;
  },
});
define('CORREL', {
  min: 2,
  max: 2,
  fn: ([first, second]) => {
    const a = matrix(first);
    const b = matrix(second);
    requireSameShape(a, b);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let r = 0; r < a.rows; r += 1) {
      for (let c = 0; c < a.cols; c += 1) {
        const x = a.get(r, c);
        const y = b.get(r, c);
        if (typeof x === 'number' && typeof y === 'number') {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    const meanX = average(xs);
    const meanY = average(ys);
    let top = 0;
    let squareX = 0;
    let squareY = 0;
    xs.forEach((x, i) => {
      top += (x - meanX) * (ys[i] - meanY);
      squareX += (x - meanX) ** 2;
      squareY += (ys[i] - meanY) ** 2;
    });
    if (squareX === 0 || squareY === 0) throw err('#DIV/0!', 'The numbers do not vary');
    return top / Math.sqrt(squareX * squareY);
  },
});

define('COUNTIF', {
  min: 2,
  max: 2,
  fn: ([range, condition], ctx) => {
    const test = criterion(ctx.scalar(condition));
    return flatten([matrix(range)]).filter(test).length;
  },
});
define('COUNTIFS', {
  min: 2,
  max: MANY,
  fn: (args, ctx) => {
    const cells = matchingCells(args, ctx);
    let count = 0;
    for (let r = 0; r < cells.rows; r += 1) {
      for (let c = 0; c < cells.cols; c += 1) if (cells.test(r, c)) count += 1;
    }
    return count;
  },
});
define('SUMIF', { min: 2, max: 3, fn: ([range, condition, values], ctx) => sum(conditional(values ?? range, [range, condition], ctx)) });
define('SUMIFS', { min: 3, max: MANY, fn: ([values, ...pairs], ctx) => sum(conditional(values, pairs, ctx)) });
define('AVERAGEIF', { min: 2, max: 3, fn: ([range, condition, values], ctx) => average(conditional(values ?? range, [range, condition], ctx)) });
define('AVERAGEIFS', { min: 3, max: MANY, fn: ([values, ...pairs], ctx) => average(conditional(values, pairs, ctx)) });
define('MAXIFS', { min: 3, max: MANY, fn: ([values, ...pairs], ctx) => largest(conditional(values, pairs, ctx)) });
define('MINIFS', { min: 3, max: MANY, fn: ([values, ...pairs], ctx) => smallest(conditional(values, pairs, ctx)) });

define('SUMPRODUCT', {
  min: 1,
  max: MANY,
  arrays: true,
  fn: (args) => {
    const ranges = args.map(matrix);
    for (const range of ranges) requireSameShape(range, ranges[0]);
    let total = 0;
    for (let r = 0; r < ranges[0].rows; r += 1) {
      for (let c = 0; c < ranges[0].cols; c += 1) {
        let product = 1;
        for (const range of ranges) {
          const value: Scalar = range.get(r, c);
          if (isError(value)) throw value;
          product *= typeof value === 'number' ? value : value === true ? 1 : 0;
        }
        total += product;
      }
    }
    return Number(total.toPrecision(15));
  },
});

unary('ABS', Math.abs);
unary('SQRT', Math.sqrt);
unary('EXP', Math.exp);
unary('LN', x => (x > 0 ? Math.log(x) : NaN));
unary('LOG10', x => (x > 0 ? Math.log10(x) : NaN));
unary('SIGN', Math.sign);
unary('INT', Math.floor);
unary('SIN', Math.sin);
unary('COS', Math.cos);
unary('TAN', Math.tan);
unary('ASIN', Math.asin);
unary('ACOS', Math.acos);
unary('ATAN', Math.atan);
unary('DEGREES', x => (x * 180) / Math.PI);
unary('RADIANS', x => (x * Math.PI) / 180);
unary('EVEN', x => Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2);
unary('ODD', x => Math.sign(x || 1) * (Math.ceil((Math.abs(x) - 1) / 2) * 2 + 1));
unary('FACT', (x) => {
  if (x < 0 || x > 170) return NaN;
  let result = 1;
  for (let n = 2; n <= Math.floor(x); n += 1) result *= n;
  return result;
});

define('PI', { min: 0, max: 0, fn: () => Math.PI });
define('RAND', { min: 0, max: 0, fn: (_args, ctx) => ctx.host.random() });
define('RANDBETWEEN', {
  min: 2,
  max: 2,
  fn: ([low, high], ctx) => {
    const bottom = Math.ceil(num(low, ctx));
    const top = Math.floor(num(high, ctx));
    if (bottom > top) throw err('#NUM!', 'The first number must not be larger than the second');
    return bottom + Math.floor(ctx.host.random() * (top - bottom + 1));
  },
});
define('ATAN2', { min: 2, max: 2, fn: ([x, y], ctx) => Math.atan2(num(y, ctx), num(x, ctx)) });
define('LOG', {
  min: 1,
  max: 2,
  fn: ([x, base], ctx) => {
    const value = num(x, ctx);
    const b = base === undefined ? 10 : num(base, ctx);
    if (value <= 0 || b <= 0 || b === 1) throw err('#NUM!', 'Logarithms need positive numbers');
    return Math.log(value) / Math.log(b);
  },
});
define(['POWER', 'POW'], {
  min: 2,
  max: 2,
  fn: ([base, exponent], ctx) => {
    const result = num(base, ctx) ** num(exponent, ctx);
    if (!Number.isFinite(result)) throw err('#NUM!', 'The result is not a number that can be shown');
    return result;
  },
});
define('MOD', {
  min: 2,
  max: 2,
  fn: ([value, divisor], ctx) => {
    const d = num(divisor, ctx);
    if (d === 0) throw err('#DIV/0!', 'Division by zero');
    const n = num(value, ctx);
    return Number((n - d * Math.floor(n / d)).toPrecision(15));
  },
});
define('QUOTIENT', {
  min: 2,
  max: 2,
  fn: ([value, divisor], ctx) => {
    const d = num(divisor, ctx);
    if (d === 0) throw err('#DIV/0!', 'Division by zero');
    return Math.trunc(num(value, ctx) / d);
  },
});
define('ROUND', { min: 1, max: 2, fn: ([value, digits], ctx) => roundDigits(num(value, ctx), digits === undefined ? 0 : int(digits, ctx), 'half') });
define('ROUNDUP', { min: 1, max: 2, fn: ([value, digits], ctx) => roundDigits(num(value, ctx), digits === undefined ? 0 : int(digits, ctx), 'up') });
define('ROUNDDOWN', { min: 1, max: 2, fn: ([value, digits], ctx) => roundDigits(num(value, ctx), digits === undefined ? 0 : int(digits, ctx), 'down') });
define('TRUNC', { min: 1, max: 2, fn: ([value, digits], ctx) => roundDigits(num(value, ctx), digits === undefined ? 0 : int(digits, ctx), 'down') });
define('MROUND', {
  min: 2,
  max: 2,
  fn: ([value, multiple], ctx) => {
    const m = num(multiple, ctx);
    const n = num(value, ctx);
    if (m === 0) return 0;
    if (Math.sign(n) * Math.sign(m) < 0) throw err('#NUM!', 'Both numbers must have the same sign');
    return Number((Math.round(n / m) * m).toPrecision(15));
  },
});
define(['CEILING', 'CEILING.MATH'], {
  min: 1,
  max: 2,
  fn: ([value, multiple], ctx) => {
    const m = multiple === undefined ? 1 : Math.abs(num(multiple, ctx));
    if (m === 0) return 0;
    return Number((Math.ceil(Number((num(value, ctx) / m).toPrecision(15))) * m).toPrecision(15));
  },
});
define(['FLOOR', 'FLOOR.MATH'], {
  min: 1,
  max: 2,
  fn: ([value, multiple], ctx) => {
    const m = multiple === undefined ? 1 : Math.abs(num(multiple, ctx));
    if (m === 0) throw err('#DIV/0!', 'Division by zero');
    return Number((Math.floor(Number((num(value, ctx) / m).toPrecision(15))) * m).toPrecision(15));
  },
});
define('GCD', { min: 1, max: MANY, fn: args => numbers(args).reduce(gcd, 0) });
define('LCM', {
  min: 1,
  max: MANY,
  fn: args => numbers(args).reduce((a, b) => {
    const x = Math.abs(Math.trunc(a));
    const y = Math.abs(Math.trunc(b));
    return x === 0 || y === 0 ? 0 : (x * y) / gcd(x, y);
  }, 1),
});

// Loans and savings.
define('PMT', {
  min: 3,
  max: 5,
  fn: ([rate, periods, present, future, atStart], ctx) => {
    const r = num(rate, ctx);
    const n = num(periods, ctx);
    const pv = num(present, ctx);
    const fv = future === undefined ? 0 : num(future, ctx);
    const due = atStart !== undefined && num(atStart, ctx) !== 0 ? 1 : 0;
    if (n === 0) throw err('#NUM!', 'The number of payments cannot be zero');
    if (r === 0) return -(pv + fv) / n;
    const growth = (1 + r) ** n;
    return (-r * (pv * growth + fv)) / ((1 + r * due) * (growth - 1));
  },
});
define('FV', {
  min: 3,
  max: 5,
  fn: ([rate, periods, payment, present, atStart], ctx) => {
    const r = num(rate, ctx);
    const n = num(periods, ctx);
    const pmt = num(payment, ctx);
    const pv = present === undefined ? 0 : num(present, ctx);
    const due = atStart !== undefined && num(atStart, ctx) !== 0 ? 1 : 0;
    if (r === 0) return -(pv + pmt * n);
    const growth = (1 + r) ** n;
    return -(pv * growth + (pmt * (1 + r * due) * (growth - 1)) / r);
  },
});
define('PV', {
  min: 3,
  max: 5,
  fn: ([rate, periods, payment, future, atStart], ctx) => {
    const r = num(rate, ctx);
    const n = num(periods, ctx);
    const pmt = num(payment, ctx);
    const fv = future === undefined ? 0 : num(future, ctx);
    const due = atStart !== undefined && num(atStart, ctx) !== 0 ? 1 : 0;
    if (r === 0) return -(fv + pmt * n);
    const growth = (1 + r) ** n;
    return -(fv + (pmt * (1 + r * due) * (growth - 1)) / r) / growth;
  },
});
define('NPV', {
  min: 2,
  max: MANY,
  fn: ([rate, ...flows], ctx) => {
    const r = num(rate, ctx);
    return numbers(flows).reduce((total, flow, index) => total + flow / (1 + r) ** (index + 1), 0);
  },
});
