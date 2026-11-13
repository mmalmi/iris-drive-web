/**
 * How a value is shown, and how typed text becomes a value.
 *
 * A number format is a pattern such as `#,##0.00`, `0%`, `$#,##0.00` or
 * `yyyy-mm-dd`, the same notation other spreadsheets use, so formats can be
 * carried over when files are exchanged. No pattern means "automatic".
 */
import { DAY_NAMES, MONTH_NAMES, parseDateText, partsFromSerial, type DateOrder } from './dates';
import { isError, numberToText, textToNumber, type Scalar } from './values';

export const TEXT_FORMAT = '@';

/**
 * A date written the way the reader's locale writes dates. The part after
 * the marker is what an app that does not know the marker shows instead.
 */
const LOCAL_DATE = '[$-x-date]';

export const NUMBER_FORMATS = {
  number: '#,##0.00',
  percent: '0.00%',
  dollar: '$#,##0.00',
  euro: '€#,##0.00',
  pound: '£#,##0.00',
  date: `${LOCAL_DATE}yyyy-mm-dd`,
  isoDate: 'yyyy-mm-dd',
  time: 'hh:mm:ss',
  dateTime: `${LOCAL_DATE}yyyy-mm-dd hh:mm`,
} as const;

/** How a locale writes numbers and dates. */
export interface NumberLocale {
  /** Such as "de-DE". */
  tag: string;
  decimal: string;
  group: string;
  dateOrder: DateOrder;
  /** A short date as a format pattern, such as "dd.mm.yyyy". */
  datePattern: string;
  /** The time of day as a format pattern, "hh:mm" or "h:mm AM/PM". */
  timePattern: string;
}

/** How numbers and dates read when nothing else is known: as in American English. */
export const DEFAULT_LOCALE: NumberLocale = {
  tag: 'en-US',
  decimal: '.',
  group: ',',
  dateOrder: 'mdy',
  datePattern: 'm/d/yyyy',
  timePattern: 'h:mm AM/PM',
};

const locales = new Map<string, NumberLocale>();

/** How the locale named by a tag such as "fi-FI" writes numbers and dates; the default for one the browser does not know. */
export function localeFor(tag: string): NumberLocale {
  let found = locales.get(tag);
  if (found) return found;
  try {
    const numberParts = new Intl.NumberFormat(tag).formatToParts(12345.6);
    const dateParts = new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(2026, 1, 5));
    let datePattern = '';
    let order = '';
    for (const part of dateParts) {
      if (part.type === 'day') datePattern += part.value.length > 1 ? 'dd' : 'd';
      else if (part.type === 'month') datePattern += part.value.length > 1 ? 'mm' : 'm';
      else if (part.type === 'year') datePattern += 'yyyy';
      else if (part.type === 'literal') datePattern += part.value.replace(/[^./\- ]/g, '');
      if (part.type === 'day' || part.type === 'month' || part.type === 'year') order += part.type[0];
    }
    const hour12 = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hour12 === true;
    found = {
      tag,
      decimal: numberParts.find(part => part.type === 'decimal')?.value ?? '.',
      group: numberParts.find(part => part.type === 'group')?.value ?? ',',
      dateOrder: order === 'dmy' || order === 'ymd' ? order : 'mdy',
      datePattern: /^[dmy./\- ]+$/.test(datePattern) && order.length === 3 ? datePattern : DEFAULT_LOCALE.datePattern,
      timePattern: hour12 ? 'h:mm AM/PM' : 'hh:mm',
    };
  } catch {
    found = { ...DEFAULT_LOCALE, tag };
  }
  locales.set(tag, found);
  return found;
}

/** The browser's own locale, which a spreadsheet without one of its own follows. */
export function browserLocale(): string {
  return typeof window !== 'undefined' && navigator.language ? navigator.language : DEFAULT_LOCALE.tag;
}

/** A pattern with the locale's own way of writing a date put in for the marker. */
function localized(pattern: string, locale: NumberLocale): string {
  if (!pattern.startsWith(LOCAL_DATE)) return pattern;
  return /[hs]/i.test(pattern.slice(LOCAL_DATE.length)) ? `${locale.datePattern} ${locale.timePattern}` : locale.datePattern;
}

export type FormatKind = 'auto' | 'text' | 'number' | 'percent' | 'currency' | 'date' | 'time' | 'dateTime';

type Part =
  | { kind: 'literal'; text: string }
  | { kind: 'digit'; char: '0' | '#' | '?' }
  | { kind: 'point' }
  | { kind: 'comma' }
  | { kind: 'percent' }
  | { kind: 'exponent'; digits: number; plus: boolean }
  | { kind: 'date'; token: string }
  | { kind: 'text' };

interface Section {
  parts: Part[];
  isDate: boolean;
}

const sectionCache = new Map<string, Section[]>();

function parseSection(source: string): Section {
  const parts: Part[] = [];
  let isDate = false;
  let at = 0;
  const literal = (text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === 'literal') last.text += text;
    else parts.push({ kind: 'literal', text });
  };
  while (at < source.length) {
    const rest = source.slice(at);
    const char = rest[0];
    if (char === '"') {
      const close = source.indexOf('"', at + 1);
      literal(source.slice(at + 1, close < 0 ? source.length : close));
      at = close < 0 ? source.length : close + 1;
    } else if (char === '\\') {
      literal(source[at + 1] ?? '');
      at += 2;
    } else if (char === '_') {
      literal(' ');
      at += 2;
    } else if (char === '*') {
      at += 2;
    } else if (char === '[') {
      // Colours and conditions are not shown; a currency such as [$€-407] is.
      const close = source.indexOf(']', at);
      const inner = source.slice(at + 1, close < 0 ? source.length : close);
      if (inner.startsWith('$')) literal(inner.slice(1).split('-')[0]);
      at = close < 0 ? source.length : close + 1;
    } else if (char === '0' || char === '#' || char === '?') {
      parts.push({ kind: 'digit', char });
      at += 1;
    } else if (char === '.') {
      parts.push({ kind: 'point' });
      at += 1;
    } else if (char === ',') {
      parts.push({ kind: 'comma' });
      at += 1;
    } else if (char === '%') {
      parts.push({ kind: 'percent' });
      at += 1;
    } else if (char === '@') {
      parts.push({ kind: 'text' });
      at += 1;
    } else if (/^E[+-]0+/.test(rest)) {
      const match = /^E([+-])(0+)/.exec(rest) as RegExpExecArray;
      parts.push({ kind: 'exponent', digits: match[2].length, plus: match[1] === '+' });
      at += match[0].length;
    } else {
      const date = /^(?:yyyy|yy|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|am\/pm|A\/P)/i.exec(rest);
      if (date) {
        parts.push({ kind: 'date', token: date[0].toLowerCase() });
        isDate = true;
        at += date[0].length;
      } else {
        literal(char);
        at += 1;
      }
    }
  }
  return { parts, isDate };
}

function sectionsOf(pattern: string): Section[] {
  let sections = sectionCache.get(pattern);
  if (!sections) {
    const sources: string[] = [];
    let current = '';
    let quoted = false;
    for (const char of pattern) {
      if (char === '"') quoted = !quoted;
      if (char === ';' && !quoted) {
        sources.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    sources.push(current);
    sections = sources.map(parseSection);
    if (sectionCache.size > 500) sectionCache.clear();
    sectionCache.set(pattern, sections);
  }
  return sections;
}

function isGeneral(pattern: string | undefined): boolean {
  return !pattern || pattern.toLowerCase() === 'general';
}

/** Rounds half away from zero at `decimals` places, as people expect of money. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const text = String(Math.abs(value));
  const shifted = text.includes('e') ? Math.abs(value) * 10 ** decimals : Number(`${text}e${decimals}`);
  const rounded = Math.round(shifted);
  const back = Number(`${rounded}e${-decimals}`);
  return value < 0 ? -back : back;
}

function group(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

function formatDateSection(section: Section, serial: number): string {
  const date = partsFromSerial(serial);
  const twelveHour = section.parts.some(part => part.kind === 'date' && /^(am\/pm|a\/p)$/.test(part.token));
  const two = (n: number) => String(n).padStart(2, '0');
  let out = '';
  section.parts.forEach((part) => {
    if (part.kind === 'literal') out += part.text;
    else if (part.kind === 'point') out += '.';
    else if (part.kind === 'comma') out += ',';
    if (part.kind !== 'date') return;
    let token = part.token;
    if (token === 'm' || token === 'mm') {
      // "m" means minutes right after hours or right before seconds.
      const dates = section.parts.filter(p => p.kind === 'date') as Array<{ kind: 'date'; token: string }>;
      const position = dates.indexOf(part);
      const before = dates[position - 1]?.token ?? '';
      const after = dates[position + 1]?.token ?? '';
      if (before.startsWith('h') || after.startsWith('s')) token = token === 'm' ? 'n' : 'nn';
    }
    const hour = twelveHour ? (date.hour % 12 || 12) : date.hour;
    switch (token) {
      case 'yyyy': out += String(date.year).padStart(4, '0'); break;
      case 'yy': out += two(date.year % 100); break;
      case 'mmmmm': out += MONTH_NAMES[date.month - 1][0]; break;
      case 'mmmm': out += MONTH_NAMES[date.month - 1]; break;
      case 'mmm': out += MONTH_NAMES[date.month - 1].slice(0, 3); break;
      case 'mm': out += two(date.month); break;
      case 'm': out += String(date.month); break;
      case 'dddd': out += DAY_NAMES[date.weekday]; break;
      case 'ddd': out += DAY_NAMES[date.weekday].slice(0, 3); break;
      case 'dd': out += two(date.day); break;
      case 'd': out += String(date.day); break;
      case 'hh': out += two(hour); break;
      case 'h': out += String(hour); break;
      case 'nn': out += two(date.minute); break;
      case 'n': out += String(date.minute); break;
      case 'ss': out += two(date.second); break;
      case 's': out += String(date.second); break;
      case 'am/pm': out += date.hour < 12 ? 'AM' : 'PM'; break;
      case 'a/p': out += date.hour < 12 ? 'A' : 'P'; break;
      default:
    }
  });
  return out;
}

function formatNumberSection(section: Section, value: number, showSign: boolean, locale: NumberLocale): string {
  const { parts } = section;
  const digitIndexes = parts.flatMap((part, index) => (part.kind === 'digit' ? [index] : []));
  if (digitIndexes.length === 0) {
    // A pattern with no digits shows only its fixed text.
    const text = parts.map(part => (part.kind === 'literal' ? part.text : part.kind === 'percent' ? '%' : '')).join('');
    return showSign && value < 0 ? `-${text}` : text;
  }
  const firstDigit = digitIndexes[0];
  const lastDigit = digitIndexes[digitIndexes.length - 1];
  const pointIndex = parts.findIndex(part => part.kind === 'point');
  const exponent = parts.find(part => part.kind === 'exponent') as { kind: 'exponent'; digits: number; plus: boolean } | undefined;

  let minIntegers = 0;
  let decimals = 0;
  let minDecimals = 0;
  let grouped = false;
  let scale = 1;
  parts.forEach((part, index) => {
    if (part.kind === 'digit') {
      const afterPoint = pointIndex >= 0 && index > pointIndex;
      if (afterPoint) {
        decimals += 1;
        if (part.char === '0') minDecimals = decimals;
      } else if (part.char === '0') {
        minIntegers += 1;
      }
    } else if (part.kind === 'comma') {
      if (index > firstDigit && index < lastDigit) grouped = true;
      else if (index > lastDigit) scale /= 1000;
    } else if (part.kind === 'percent') {
      scale *= 100;
    }
  });

  let magnitude = Math.abs(value) * scale;
  let body: string;
  if (exponent) {
    const [mantissa, power] = magnitude.toExponential(decimals).split('e');
    const sign = power.startsWith('-') ? '-' : exponent.plus ? '+' : '';
    body = `${mantissa.replace('.', locale.decimal)}E${sign}${power.replace(/^[+-]/, '').padStart(exponent.digits, '0')}`;
  } else {
    magnitude = roundTo(magnitude, decimals);
    const fixed = magnitude.toFixed(decimals);
    let [whole, fraction = ''] = fixed.split('.');
    while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    if (whole === '0' && minIntegers === 0 && fraction) whole = '';
    whole = whole.padStart(minIntegers, '0');
    if (grouped) whole = group(whole, locale.group);
    body = fraction ? `${whole}${locale.decimal}${fraction}` : whole;
  }

  let prefix = '';
  let suffix = '';
  parts.forEach((part, index) => {
    const text = part.kind === 'literal' ? part.text : part.kind === 'percent' ? '%' : '';
    if (!text) return;
    if (index < firstDigit) prefix += text;
    else if (index > lastDigit) suffix += text;
  });
  const negative = showSign && value < 0 && Number(body.replace(/[^0-9]/g, '')) !== 0;
  return `${negative ? '-' : ''}${prefix}${body}${suffix}`;
}

/** A number shown without a format: enough digits to be exact, not more than fit a cell. */
export function formatGeneral(value: number, locale: NumberLocale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  let text: string;
  if (magnitude !== 0 && (magnitude >= 1e15 || magnitude < 1e-9)) {
    const [mantissa, power] = value.toExponential(5).split('e');
    text = `${Number(mantissa)}E${power.startsWith('-') ? '-' : '+'}${power.replace(/^[+-]/, '').padStart(2, '0')}`;
  } else {
    text = numberToText(Number(value.toPrecision(10)));
  }
  return locale.decimal === '.' ? text : text.replace('.', locale.decimal);
}

/** The text a cell shows for a value under a number format. */
export function formatValue(value: Scalar, format?: string, locale: NumberLocale = DEFAULT_LOCALE): string {
  if (value === null) return '';
  const pattern = format && localized(format, locale);
  if (isError(value)) return value.code;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') {
    if (isGeneral(pattern)) return value;
    const sections = sectionsOf(pattern as string);
    const textSection = sections[3] ?? (sections.length === 1 && sections[0].parts.some(p => p.kind === 'text') ? sections[0] : null);
    if (!textSection) return value;
    return textSection.parts.map(p => (p.kind === 'literal' ? p.text : p.kind === 'text' ? value : '')).join('');
  }
  if (isGeneral(pattern)) return formatGeneral(value, locale);
  const sections = sectionsOf(pattern as string);
  if (sections[0].parts.some(part => part.kind === 'text')) return formatGeneral(value, locale);
  let section = sections[0];
  let showSign = true;
  if (value < 0 && sections.length >= 2) {
    section = sections[1];
    showSign = false;
  } else if (value === 0 && sections.length >= 3) {
    section = sections[2];
  }
  if (section.isDate) return value < 0 ? formatGeneral(value, locale) : formatDateSection(section, value);
  return formatNumberSection(section, value, showSign, locale);
}

export function formatKind(pattern: string | undefined): FormatKind {
  if (isGeneral(pattern)) return 'auto';
  const [section] = sectionsOf(pattern as string);
  if (section.parts.some(part => part.kind === 'text')) return 'text';
  if (section.isDate) {
    const tokens = section.parts.flatMap(part => (part.kind === 'date' ? [part.token] : []));
    const hasDay = tokens.some(token => /^[yd]/.test(token));
    const hasTime = tokens.some(token => /^[hs]/.test(token));
    return hasDay && hasTime ? 'dateTime' : hasTime ? 'time' : 'date';
  }
  if (section.parts.some(part => part.kind === 'percent')) return 'percent';
  if (section.parts.some(part => part.kind === 'literal' && /[$€£¥₿]|kr|CHF/.test(part.text))) return 'currency';
  return 'number';
}

export function isDateFormat(pattern: string | undefined): boolean {
  const kind = formatKind(pattern);
  return kind === 'date' || kind === 'time' || kind === 'dateTime';
}

/** The same format with more or fewer decimal places. `sample` picks the start for automatic. */
export function changeDecimals(pattern: string | undefined, delta: number, sample: number): string | undefined {
  let base = pattern;
  if (isGeneral(base)) {
    const shown = formatGeneral(sample);
    const places = shown.includes('E') ? 2 : (shown.split('.')[1]?.length ?? 0);
    base = places > 0 ? `0.${'0'.repeat(places)}` : '0';
  }
  if (isDateFormat(base) || formatKind(base) === 'text') return pattern;
  return (base as string).split(';').map((section) => {
    const match = /^(.*?[0#?])(?:\.([0#?]+))?((?:E[+-]0+)?[^0#?]*)$/.exec(section);
    if (!match) return section;
    const places = Math.max(0, Math.min(15, (match[2]?.length ?? 0) + delta));
    return `${match[1]}${places > 0 ? `.${'0'.repeat(places)}` : ''}${match[3]}`;
  }).join(';');
}

export interface ParsedInput {
  value: number | string | boolean | null;
  /** A format the typed text implies, such as a date or a percentage. */
  format?: string;
}

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;
const COMMA_DECIMAL = /^[+-]?\d+,\d+$/;
const CURRENCY_SIGNS = '$€£¥';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const groupedPatterns = new Map<string, RegExp>();

/** "1.234,5" where the decimal sign is a comma, with any space typed for a space that groups digits. */
function groupedIn(locale: NumberLocale): RegExp {
  let pattern = groupedPatterns.get(locale.tag);
  if (!pattern) {
    const group = /\s/.test(locale.group) ? '[\\s\u00a0\u202f]' : escape(locale.group);
    pattern = new RegExp(`^[+-]?\\d{1,3}(?:${group}\\d{3})+(?:${escape(locale.decimal)}\\d*)?$`);
    groupedPatterns.set(locale.tag, pattern);
  }
  return pattern;
}

function readNumber(text: string, locale: NumberLocale = DEFAULT_LOCALE): { value: number; decimals: number; grouped: boolean } | null {
  if (locale.decimal !== '.') {
    // A comma (or other sign) for the decimal point; a point alone still reads as one, as in "3.14".
    const plain = new RegExp(`^[+-]?(?:\\d+${escape(locale.decimal)}?\\d*|${escape(locale.decimal)}\\d+)$`);
    if (plain.test(text)) {
      const [, fraction = ''] = text.split(locale.decimal);
      return { value: Number(text.replace(locale.decimal, '.')), decimals: fraction.length, grouped: false };
    }
    if (groupedIn(locale).test(text)) {
      const [whole, fraction = ''] = text.split(locale.decimal);
      return { value: Number(`${whole.replace(/\D/g, '')}.${fraction || '0'}`) * (text.startsWith('-') ? -1 : 1), decimals: fraction.length, grouped: true };
    }
    if (PLAIN_NUMBER.test(text) && !/^[+-]?\d{1,3}\.\d{3}$/.test(text)) {
      return { value: Number(text), decimals: /[eE]/.test(text) ? 0 : (text.split('.')[1]?.length ?? 0), grouped: false };
    }
    return null;
  }
  if (PLAIN_NUMBER.test(text)) {
    return { value: Number(text), decimals: /[eE]/.test(text) ? 0 : (text.split('.')[1]?.length ?? 0), grouped: false };
  }
  if (GROUPED_NUMBER.test(text)) {
    return { value: Number(text.replace(/,/g, '')), decimals: text.split('.')[1]?.length ?? 0, grouped: true };
  }
  // "1,5" is one and a half; "1,500" was matched above as fifteen hundred.
  if (COMMA_DECIMAL.test(text)) {
    return { value: Number(text.replace(',', '.')), decimals: text.split(',')[1].length, grouped: false };
  }
  return null;
}

function decimalsPattern(decimals: number): string {
  return decimals > 0 ? `.${'0'.repeat(Math.min(decimals, 10))}` : '';
}

/** Turns what was typed into a cell into a value. Formulas are handled by the caller. */
export function parseInput(input: string, currentFormat?: string, locale: NumberLocale = DEFAULT_LOCALE): ParsedInput {
  if (input === '') return { value: null };
  if (currentFormat === TEXT_FORMAT) return { value: input };
  if (input.startsWith("'")) return { value: input.slice(1) };
  const text = input.trim();
  if (text === '') return { value: input };
  const upper = text.toUpperCase();
  if (upper === 'TRUE') return { value: true };
  if (upper === 'FALSE') return { value: false };

  const plain = readNumber(text, locale);
  if (plain) return plain.grouped ? { value: plain.value, format: `#,##0${decimalsPattern(plain.decimals)}` } : { value: plain.value };

  if (text.endsWith('%')) {
    const number = readNumber(text.slice(0, -1).trim(), locale);
    if (number) return { value: number.value / 100, format: `0${decimalsPattern(number.decimals)}%` };
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1).trim() : text;
  if (CURRENCY_SIGNS.includes(unsigned[0])) {
    const number = readNumber(unsigned.slice(1).trim(), locale);
    if (number && number.value >= 0) {
      return { value: negative ? -number.value : number.value, format: `${unsigned[0]}#,##0.00` };
    }
  }
  if (CURRENCY_SIGNS.includes(unsigned[unsigned.length - 1])) {
    const number = readNumber(unsigned.slice(0, -1).trim(), locale);
    if (number && number.value >= 0) {
      return { value: negative ? -number.value : number.value, format: `#,##0.00 ${unsigned[unsigned.length - 1]}` };
    }
  }

  const date = parseDateText(text, locale.dateOrder);
  if (date) {
    if (date.kind === 'time') return { value: date.serial, format: /:\d\d:\d\d/.test(text) ? 'hh:mm:ss' : 'hh:mm' };
    // Written the way the locale writes dates, a date is shown to each reader the way theirs does.
    const separator = locale.datePattern.replace(/[dmy]/g, '')[0] ?? '';
    const typedSeparator = /^\d+([./-])/.exec(text)?.[1] ?? '';
    const sameOrder = date.order === undefined || date.order === locale.dateOrder;
    if (typedSeparator === separator && sameOrder && (separator !== '-' || locale.dateOrder !== 'ymd' || !/^\d{4}-/.test(text))) {
      return { value: date.serial, format: date.kind === 'date' ? NUMBER_FORMATS.date : NUMBER_FORMATS.dateTime };
    }
    const slashOrder = date.order === 'dmy' ? 'd/m/yyyy' : 'm/d/yyyy';
    const dayPattern = /^\d{1,2}\.\d/.test(text) ? 'd.m.yyyy' : /^\d{1,2}\/\d/.test(text) ? slashOrder : 'yyyy-mm-dd';
    return { value: date.serial, format: date.kind === 'date' ? dayPattern : `${dayPattern} hh:mm` };
  }
  return { value: input };
}

/** The text to edit for a stored value: typing it back gives the same value. */
export function editTextOf(value: number | string | boolean | null, pattern?: string, locale: NumberLocale = DEFAULT_LOCALE): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    const kind = formatKind(pattern);
    const local = pattern?.startsWith(LOCAL_DATE) === true;
    const typed = pattern === 'd.m.yyyy' || pattern === 'm/d/yyyy' || pattern === 'd/m/yyyy' ? pattern : 'yyyy-mm-dd';
    if (kind === 'date' && Number.isInteger(value) && value >= 0) return formatValue(value, local ? locale.datePattern : typed);
    if (kind === 'dateTime' && value >= 0) return formatValue(value, `${local ? locale.datePattern : 'yyyy-mm-dd'} hh:mm:ss`);
    if (kind === 'time' && value >= 0 && value < 1) return formatValue(value, 'hh:mm:ss');
    const decimal = (text: string) => (locale.decimal === '.' ? text : text.replace('.', locale.decimal));
    if (kind === 'percent') return `${decimal(numberToText(roundTo(value * 100, 10)))}%`;
    return decimal(numberToText(value));
  }
  if (pattern === TEXT_FORMAT) return value;
  // Text that would be read as something else keeps its meaning behind an apostrophe.
  const reparsed = parseInput(value, undefined, locale);
  const needsMark = value.startsWith('=') || value.startsWith("'") || typeof reparsed.value !== 'string';
  return needsMark ? `'${value}` : value;
}

export { textToNumber };
