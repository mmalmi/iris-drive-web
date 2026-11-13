/** Dates and times. */
import { parseDateText, partsFromSerial, serialFromLocalDate, serialFromTime, serialFromYmd } from '../../dates';
import { isError, isMatrix, type Value } from '../../values';
import { defineFunction as define, type FnContext } from '../evaluate';
import { err, flatten, int, num, plain } from '../helpers';

/** A date given as a number or as text such as "2026-11-13". */
function serial(value: Value, ctx: FnContext): number {
  const scalar = plain(value, ctx);
  if (typeof scalar === 'string') {
    const parsed = parseDateText(scalar);
    if (!parsed) throw err('#VALUE!', `"${scalar}" is not a date`);
    return parsed.serial;
  }
  const number = num(scalar, ctx);
  if (number < 0) throw err('#NUM!', 'Dates cannot be negative');
  return number;
}

function day(value: Value, ctx: FnContext): number {
  return Math.floor(serial(value, ctx));
}

function part(name: string, pick: (parts: ReturnType<typeof partsFromSerial>) => number): void {
  define(name, { min: 1, max: 1, fn: ([value], ctx) => pick(partsFromSerial(serial(value, ctx))) });
}

function addMonths(start: number, months: number, endOfMonth: boolean): number {
  const from = partsFromSerial(start);
  if (endOfMonth) return serialFromYmd(from.year, from.month + months + 1, 0);
  const lastDay = partsFromSerial(serialFromYmd(from.year, from.month + months + 1, 0)).day;
  return serialFromYmd(from.year, from.month + months, Math.min(from.day, lastDay));
}

function holidays(value: Value | undefined): Set<number> {
  const days = new Set<number>();
  if (value === undefined || value === null) return days;
  for (const entry of isMatrix(value) ? flatten([value]) : [value]) {
    if (isError(entry)) throw entry;
    if (typeof entry === 'number') days.add(Math.floor(entry));
  }
  return days;
}

function isWorkday(dayNumber: number, off: Set<number>): boolean {
  const weekday = partsFromSerial(dayNumber).weekday;
  return weekday !== 0 && weekday !== 6 && !off.has(dayNumber);
}

/** ISO 8601 week number: weeks start on Monday and week 1 holds the first Thursday. */
function isoWeek(dayNumber: number): number {
  const weekday = (partsFromSerial(dayNumber).weekday + 6) % 7;
  const thursday = dayNumber - weekday + 3;
  const firstOfYear = serialFromYmd(partsFromSerial(thursday).year, 1, 1);
  return Math.floor((thursday - firstOfYear) / 7) + 1;
}

define('TODAY', { min: 0, max: 0, fn: (_args, ctx) => Math.floor(serialFromLocalDate(ctx.host.now())) });
define('NOW', { min: 0, max: 0, fn: (_args, ctx) => serialFromLocalDate(ctx.host.now()) });
define('DATE', {
  min: 3,
  max: 3,
  fn: ([year, month, dayOfMonth], ctx) => {
    const y = int(year, ctx);
    if (y < 0 || y > 9999) throw err('#NUM!', 'The year must be between 0 and 9999');
    const result = serialFromYmd(y < 1900 ? y + 1900 : y, int(month, ctx), int(dayOfMonth, ctx));
    if (result < 0) throw err('#NUM!', 'That date is too early');
    return result;
  },
});
define('TIME', {
  min: 3,
  max: 3,
  fn: ([hour, minute, second], ctx) => {
    const time = serialFromTime(int(hour, ctx), int(minute, ctx), int(second, ctx));
    if (time < 0) throw err('#NUM!', 'Times cannot be negative');
    return time - Math.floor(time);
  },
});
define('DATEVALUE', {
  min: 1,
  max: 1,
  fn: ([value], ctx) => day(value, ctx),
});
define('TIMEVALUE', {
  min: 1,
  max: 1,
  fn: ([value], ctx) => {
    const s = serial(value, ctx);
    return s - Math.floor(s);
  },
});
part('YEAR', parts => parts.year);
part('MONTH', parts => parts.month);
part('DAY', parts => parts.day);
part('HOUR', parts => parts.hour);
part('MINUTE', parts => parts.minute);
part('SECOND', parts => parts.second);
define('WEEKDAY', {
  min: 1,
  max: 2,
  fn: ([value, typeArg], ctx) => {
    const weekday = partsFromSerial(serial(value, ctx)).weekday;
    const type = typeArg === undefined ? 1 : int(typeArg, ctx);
    if (type === 1) return weekday + 1;
    if (type === 2) return ((weekday + 6) % 7) + 1;
    if (type === 3) return (weekday + 6) % 7;
    throw err('#NUM!', 'The type must be 1, 2 or 3');
  },
});
define('ISOWEEKNUM', { min: 1, max: 1, fn: ([value], ctx) => isoWeek(day(value, ctx)) });
define('WEEKNUM', {
  min: 1,
  max: 2,
  fn: ([value, typeArg], ctx) => {
    const dayNumber = day(value, ctx);
    const type = typeArg === undefined ? 1 : int(typeArg, ctx);
    if (type === 21) return isoWeek(dayNumber);
    if (type !== 1 && type !== 2) throw err('#NUM!', 'The type must be 1, 2 or 21');
    const firstOfYear = serialFromYmd(partsFromSerial(dayNumber).year, 1, 1);
    const offset = (partsFromSerial(firstOfYear).weekday - (type === 2 ? 1 : 0) + 7) % 7;
    return Math.floor((dayNumber - firstOfYear + offset) / 7) + 1;
  },
});
define('EDATE', { min: 2, max: 2, fn: ([start, months], ctx) => addMonths(day(start, ctx), int(months, ctx), false) });
define('EOMONTH', { min: 2, max: 2, fn: ([start, months], ctx) => addMonths(day(start, ctx), int(months, ctx), true) });
define('DAYS', { min: 2, max: 2, fn: ([end, start], ctx) => day(end, ctx) - day(start, ctx) });
define('DATEDIF', {
  min: 3,
  max: 3,
  fn: ([startArg, endArg, unitArg], ctx) => {
    const start = day(startArg, ctx);
    const end = day(endArg, ctx);
    if (start > end) throw err('#NUM!', 'The start date is after the end date');
    const unit = String(plain(unitArg, ctx)).toUpperCase();
    const a = partsFromSerial(start);
    const b = partsFromSerial(end);
    const months = (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);
    switch (unit) {
      case 'D': return end - start;
      case 'M': return months;
      case 'Y': return Math.floor(months / 12);
      case 'YM': return months % 12;
      case 'MD': return end - addMonths(start, months, false);
      case 'YD': return end - addMonths(start, Math.floor(months / 12) * 12, false);
      default: throw err('#NUM!', 'The unit must be "Y", "M", "D", "YM", "MD" or "YD"');
    }
  },
});
define('YEARFRAC', {
  min: 2,
  max: 3,
  fn: ([startArg, endArg], ctx) => Math.abs(day(endArg, ctx) - day(startArg, ctx)) / 365.25,
});
define('NETWORKDAYS', {
  min: 2,
  max: 3,
  fn: ([startArg, endArg, holidayArg], ctx) => {
    const start = day(startArg, ctx);
    const end = day(endArg, ctx);
    const off = holidays(holidayArg);
    const [from, to] = start <= end ? [start, end] : [end, start];
    if (to - from > 1_000_000) throw err('#NUM!', 'The dates are too far apart');
    let count = 0;
    for (let d = from; d <= to; d += 1) if (isWorkday(d, off)) count += 1;
    return start <= end ? count : -count;
  },
});
define('WORKDAY', {
  min: 2,
  max: 3,
  fn: ([startArg, daysArg, holidayArg], ctx) => {
    let current = day(startArg, ctx);
    let left = int(daysArg, ctx);
    if (Math.abs(left) > 1_000_000) throw err('#NUM!', 'That is too many days');
    const off = holidays(holidayArg);
    const step = left < 0 ? -1 : 1;
    while (left !== 0) {
      current += step;
      if (isWorkday(current, off)) left -= step;
    }
    return current;
  },
});
