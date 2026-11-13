/**
 * Dates are numbers: whole days since 30 December 1899, with the time of day
 * as the fraction. This is the numbering other spreadsheets use, so dates
 * survive copying to and from them.
 */

const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(1899, 11, 30);

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
}

export function serialFromYmd(year: number, month: number, day: number): number {
  // Date.UTC treats years below 100 as 19xx; setUTCFullYear does not.
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year + Math.floor((month - 1) / 12), ((month - 1) % 12 + 12) % 12, day);
  return Math.round((date.getTime() - EPOCH_MS) / DAY_MS);
}

export function serialFromTime(hour: number, minute: number, second: number): number {
  return (hour * 3600 + minute * 60 + second) / 86_400;
}

export function partsFromSerial(serial: number): DateParts {
  let days = Math.floor(serial);
  // Rounded to the second, so 0.5 is noon and not 11:59:59.
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    seconds -= 86_400;
    days += 1;
  }
  const date = new Date(EPOCH_MS + days * DAY_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    second: seconds % 60,
    weekday: date.getUTCDay(),
  };
}

/** The serial number of a moment as the clock on this device shows it. */
export function serialFromLocalDate(date: Date): number {
  const days = serialFromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return days + serialFromTime(date.getHours(), date.getMinutes(), date.getSeconds());
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 0 || year > 9999) return false;
  const parts = partsFromSerial(serialFromYmd(year, month, day));
  return parts.year === year && parts.month === month && parts.day === day;
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length > 2) return year;
  return year < 30 ? 2000 + year : 1900 + year;
}

function monthFromName(name: string): number {
  const lower = name.toLowerCase().replace(/\.$/, '');
  if (lower.length < 3) return 0;
  const index = MONTH_NAMES.findIndex(month => month.toLowerCase().startsWith(lower));
  return index + 1;
}

/** The order a locale writes a date's day, month and year in. */
export type DateOrder = 'dmy' | 'mdy' | 'ymd';

const TIME = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?`;
const TIME_ONLY = new RegExp(`^${TIME}$`);
const DATE_PATTERNS: Array<{ pattern: RegExp; read: (m: RegExpExecArray, order: DateOrder) => [number, number, number] | null }> = [
  // 2026-11-13, 2026/11/13
  { pattern: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, read: m => [Number(m[1]), Number(m[2]), Number(m[3])] },
  // 11/13/2026, or 13/11/2026 where the day comes first. A first number above 12 can only be a day.
  {
    pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?!\d)/,
    read: (m, order) => {
      const [first, second] = [Number(m[1]), Number(m[2])];
      const dayFirst = order === 'dmy' ? second <= 12 || first > 12 : first > 12 && second <= 12;
      return dayFirst ? [fullYear(m[3]), second, first] : [fullYear(m[3]), first, second];
    },
  },
  // 13.11.2026
  { pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?!\d)/, read: m => [fullYear(m[3]), Number(m[2]), Number(m[1])] },
  // 13 Nov 2026, 13 November 2026
  {
    pattern: /^(\d{1,2})[ -]([A-Za-z]{3,9}\.?)[ -,]+(\d{4})/,
    read: m => (monthFromName(m[2]) ? [Number(m[3]), monthFromName(m[2]), Number(m[1])] : null),
  },
  // Nov 13, 2026
  {
    pattern: /^([A-Za-z]{3,9}\.?) (\d{1,2}),? (\d{4})/,
    read: m => (monthFromName(m[1]) ? [Number(m[3]), monthFromName(m[1]), Number(m[2])] : null),
  },
];

function timeFromMatch(hourText: string, minuteText: string, secondText: string | undefined, half: string | undefined): number | null {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  if (minute > 59 || second > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half.toLowerCase() === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return serialFromTime(hour, minute, second);
}

export interface ParsedDate {
  serial: number;
  kind: 'date' | 'time' | 'datetime';
  /** For a date with slashes: whether its day came first. */
  order?: DateOrder;
}

/** Reads a date, a time or both as a person would type them; `order` says how to read 1/2/2026. */
export function parseDateText(input: string, order: DateOrder = 'mdy'): ParsedDate | null {
  const text = input.trim();
  const onlyTime = TIME_ONLY.exec(text);
  if (onlyTime) {
    const time = timeFromMatch(onlyTime[1], onlyTime[2], onlyTime[3], onlyTime[4]);
    return time === null ? null : { serial: time, kind: 'time' };
  }
  for (const { pattern, read } of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const ymd = read(match, order);
    if (!ymd || !isValidYmd(ymd[0], ymd[1], ymd[2])) return null;
    const days = serialFromYmd(ymd[0], ymd[1], ymd[2]);
    const slashes = /^\d{1,2}\//.test(text) ? { order: (Number(match[1]) === ymd[2] && Number(match[2]) === ymd[1] ? 'dmy' : 'mdy') as DateOrder } : {};
    const rest = text.slice(match[0].length).replace(/^[T ]\s*/, '');
    if (!rest) return { serial: days, kind: 'date', ...slashes };
    const timeMatch = TIME_ONLY.exec(rest);
    if (!timeMatch) return null;
    const time = timeFromMatch(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    return time === null ? null : { serial: days + time, kind: 'datetime', ...slashes };
  }
  return null;
}
