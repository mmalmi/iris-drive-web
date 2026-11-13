/** Working with text. */
import { formatValue, parseInput } from '../../format';
import { isError, toText, type Scalar } from '../../values';
import { defineFunction as define } from '../evaluate';
import { err, flatten, hasWildcard, int, num, plain, text } from '../helpers';

const MANY = Infinity;

function joined(values: Scalar[]): string {
  let out = '';
  for (const value of values) {
    if (isError(value)) throw value;
    out += toText(value);
  }
  return out;
}

function count(value: number, what: string): number {
  if (value < 0) throw err('#VALUE!', `${what} cannot be negative`);
  return value;
}

/** A wildcard pattern for SEARCH, which looks anywhere in the text. */
function searchPattern(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '~' && i + 1 < pattern.length) {
      i += 1;
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (char === '*') source += '.*?';
    else if (char === '?') source += '.';
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source, 'is');
}

define(['CONCATENATE', 'CONCAT'], { min: 1, max: MANY, fn: args => joined(flatten(args)) });
define(['TEXTJOIN'], {
  min: 3,
  max: MANY,
  fn: ([separator, skipEmpty, ...values], ctx) => {
    const between = text(separator, ctx);
    const skip = plain(skipEmpty, ctx);
    const parts = flatten(values).filter(value => !(skip && (value === null || value === '')));
    for (const part of parts) if (isError(part)) throw part;
    return parts.map(toText).join(between);
  },
});
define('JOIN', {
  min: 2,
  max: MANY,
  fn: ([separator, ...values], ctx) => {
    const parts = flatten(values);
    for (const part of parts) if (isError(part)) throw part;
    return parts.map(toText).join(text(separator, ctx));
  },
});
define('LEN', { min: 1, max: 1, fn: ([value], ctx) => text(value, ctx).length });
define('LOWER', { min: 1, max: 1, fn: ([value], ctx) => text(value, ctx).toLowerCase() });
define('UPPER', { min: 1, max: 1, fn: ([value], ctx) => text(value, ctx).toUpperCase() });
define('PROPER', {
  min: 1,
  max: 1,
  fn: ([value], ctx) => text(value, ctx).toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_all, before: string, letter: string) => before + letter.toUpperCase()),
});
define('TRIM', { min: 1, max: 1, fn: ([value], ctx) => text(value, ctx).trim().replace(/ {2,}/g, ' ') });
define('CLEAN', { min: 1, max: 1, fn: ([value], ctx) => text(value, ctx).replace(/\p{Cc}/gu, '') });
define('LEFT', { min: 1, max: 2, fn: ([value, length], ctx) => text(value, ctx).slice(0, count(length === undefined ? 1 : int(length, ctx), 'The length')) });
define('RIGHT', {
  min: 1,
  max: 2,
  fn: ([value, length], ctx) => {
    const size = count(length === undefined ? 1 : int(length, ctx), 'The length');
    const source = text(value, ctx);
    return size === 0 ? '' : source.slice(-size);
  },
});
define('MID', {
  min: 3,
  max: 3,
  fn: ([value, start, length], ctx) => {
    const from = int(start, ctx);
    if (from < 1) throw err('#VALUE!', 'The start must be 1 or more');
    return text(value, ctx).substr(from - 1, count(int(length, ctx), 'The length'));
  },
});
define('REPT', {
  min: 2,
  max: 2,
  fn: ([value, times], ctx) => {
    const source = text(value, ctx);
    const n = count(int(times, ctx), 'The number of repeats');
    if (source.length * n > 32_767) throw err('#VALUE!', 'The result would be too long');
    return source.repeat(n);
  },
});
define('SUBSTITUTE', {
  min: 3,
  max: 4,
  fn: ([value, search, replacement, occurrence], ctx) => {
    const source = text(value, ctx);
    const find = text(search, ctx);
    const put = text(replacement, ctx);
    if (find === '') return source;
    if (occurrence === undefined) return source.split(find).join(put);
    const wanted = int(occurrence, ctx);
    if (wanted < 1) throw err('#VALUE!', 'The occurrence must be 1 or more');
    let at = -1;
    for (let seen = 0; seen < wanted; seen += 1) {
      at = source.indexOf(find, at + 1);
      if (at < 0) return source;
    }
    return source.slice(0, at) + put + source.slice(at + find.length);
  },
});
define('REPLACE', {
  min: 4,
  max: 4,
  fn: ([value, start, length, replacement], ctx) => {
    const source = text(value, ctx);
    const from = int(start, ctx);
    if (from < 1) throw err('#VALUE!', 'The start must be 1 or more');
    return source.slice(0, from - 1) + text(replacement, ctx) + source.slice(from - 1 + count(int(length, ctx), 'The length'));
  },
});
define('FIND', {
  min: 2,
  max: 3,
  fn: ([search, value, start], ctx) => {
    const from = start === undefined ? 1 : int(start, ctx);
    if (from < 1) throw err('#VALUE!', 'The start must be 1 or more');
    const at = text(value, ctx).indexOf(text(search, ctx), from - 1);
    if (at < 0) throw err('#VALUE!', `"${text(search, ctx)}" was not found`);
    return at + 1;
  },
});
define('SEARCH', {
  min: 2,
  max: 3,
  fn: ([search, value, start], ctx) => {
    const from = start === undefined ? 1 : int(start, ctx);
    if (from < 1) throw err('#VALUE!', 'The start must be 1 or more');
    const needle = text(search, ctx);
    const haystack = text(value, ctx).slice(from - 1);
    const at = hasWildcard(needle) ? haystack.search(searchPattern(needle)) : haystack.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) throw err('#VALUE!', `"${needle}" was not found`);
    return at + from;
  },
});
define('EXACT', { min: 2, max: 2, fn: ([a, b], ctx) => text(a, ctx) === text(b, ctx) });
define('CHAR', {
  min: 1,
  max: 1,
  fn: ([code], ctx) => {
    const n = int(code, ctx);
    if (n < 1 || n > 0x10ffff) throw err('#NUM!', 'There is no character with that number');
    return String.fromCodePoint(n);
  },
});
define(['CODE', 'UNICODE'], {
  min: 1,
  max: 1,
  fn: ([value], ctx) => {
    const code = text(value, ctx).codePointAt(0);
    if (code === undefined) throw err('#VALUE!', 'The text is empty');
    return code;
  },
});
define('T', { min: 1, max: 1, fn: ([value], ctx) => { const v = plain(value, ctx); return typeof v === 'string' ? v : ''; } });
define('N', { min: 1, max: 1, fn: ([value], ctx) => { const v = plain(value, ctx); return typeof v === 'number' ? v : v === true ? 1 : 0; } });
define('VALUE', {
  min: 1,
  max: 1,
  fn: ([value], ctx) => {
    const v = plain(value, ctx);
    if (typeof v === 'number') return v;
    const parsed = parseInput(toText(v).trim());
    if (typeof parsed.value !== 'number') throw err('#VALUE!', `"${toText(v)}" cannot be read as a number`);
    return parsed.value;
  },
});
define('TEXT', {
  min: 2,
  max: 2,
  // Written the way the spreadsheet writes numbers and dates: month names in its language too.
  fn: ([value, pattern], ctx) => formatValue(plain(value, ctx), text(pattern, ctx), ctx.host.locale?.()),
});
define('FIXED', {
  min: 1,
  max: 3,
  fn: ([value, decimals, noCommas], ctx) => {
    const places = decimals === undefined ? 2 : Math.max(0, int(decimals, ctx));
    const grouped = noCommas === undefined || !plain(noCommas, ctx);
    return formatValue(num(value, ctx), `${grouped ? '#,##0' : '0'}${places ? `.${'0'.repeat(places)}` : ''}`, ctx.host.locale?.());
  },
});
