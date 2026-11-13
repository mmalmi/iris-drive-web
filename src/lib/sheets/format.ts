/**
 * How a value is shown, and how typed text becomes a value.
 *
 * A number format is a pattern such as `#,##0.00`, `0%`, `$#,##0.00` or
 * `yyyy-mm-dd`, the same notation other spreadsheets use, so formats can be
 * carried over when files are exchanged. No pattern means "automatic".
 */
import { DAY_NAMES, MONTH_NAMES, parseDateText, partsFromSerial } from './dates';
import { isError, numberToText, textToNumber, type Scalar } from './values';

export const TEXT_FORMAT = '@';

export const NUMBER_FORMATS = {
  number: '#,##0.00',
  percent: '0.00%',
  dollar: '$#,##0.00',
  euro: '€#,##0.00',
  pound: '£#,##0.00',
  date: 'yyyy-mm-dd',
  time: 'hh:mm:ss',
  dateTime: 'yyyy-mm-dd hh:mm',
} as const;

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

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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

function formatNumberSection(section: Section, value: number, showSign: boolean): string {
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
    body = `${mantissa}E${sign}${power.replace(/^[+-]/, '').padStart(exponent.digits, '0')}`;
  } else {
    magnitude = roundTo(magnitude, decimals);
    const fixed = magnitude.toFixed(decimals);
    let [whole, fraction = ''] = fixed.split('.');
    while (fraction.length > minDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
    if (whole === '0' && minIntegers === 0 && fraction) whole = '';
    whole = whole.padStart(minIntegers, '0');
    if (grouped) whole = group(whole);
    body = fraction ? `${whole}.${fraction}` : whole;
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
export function formatGeneral(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e15 || magnitude < 1e-9)) {
    const [mantissa, power] = value.toExponential(5).split('e');
    return `${Number(mantissa)}E${power.startsWith('-') ? '-' : '+'}${power.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  return numberToText(Number(value.toPrecision(10)));
}

/** The text a cell shows for a value under a number format. */
export function formatValue(value: Scalar, pattern?: string): string {
  if (value === null) return '';
  if (isError(value)) return value.code;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') {
    if (isGeneral(pattern)) return value;
    const sections = sectionsOf(pattern as string);
    const textSection = sections[3] ?? (sections.length === 1 && sections[0].parts.some(p => p.kind === 'text') ? sections[0] : null);
    if (!textSection) return value;
    return textSection.parts.map(p => (p.kind === 'literal' ? p.text : p.kind === 'text' ? value : '')).join('');
  }
  if (isGeneral(pattern)) return formatGeneral(value);
  const sections = sectionsOf(pattern as string);
  if (sections[0].parts.some(part => part.kind === 'text')) return formatGeneral(value);
  let section = sections[0];
  let showSign = true;
  if (value < 0 && sections.length >= 2) {
    section = sections[1];
    showSign = false;
  } else if (value === 0 && sections.length >= 3) {
    section = sections[2];
  }
  if (section.isDate) return value < 0 ? formatGeneral(value) : formatDateSection(section, value);
  return formatNumberSection(section, value, showSign);
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

function readNumber(text: string): { value: number; decimals: number; grouped: boolean } | null {
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
export function parseInput(input: string, currentFormat?: string): ParsedInput {
  if (input === '') return { value: null };
  if (currentFormat === TEXT_FORMAT) return { value: input };
  if (input.startsWith("'")) return { value: input.slice(1) };
  const text = input.trim();
  if (text === '') return { value: input };
  const upper = text.toUpperCase();
  if (upper === 'TRUE') return { value: true };
  if (upper === 'FALSE') return { value: false };

  const plain = readNumber(text);
  if (plain) return plain.grouped ? { value: plain.value, format: `#,##0${decimalsPattern(plain.decimals)}` } : { value: plain.value };

  if (text.endsWith('%')) {
    const number = readNumber(text.slice(0, -1).trim());
    if (number) return { value: number.value / 100, format: `0${decimalsPattern(number.decimals)}%` };
  }

  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1).trim() : text;
  if (CURRENCY_SIGNS.includes(unsigned[0])) {
    const number = readNumber(unsigned.slice(1).trim());
    if (number && number.value >= 0) {
      return { value: negative ? -number.value : number.value, format: `${unsigned[0]}#,##0.00` };
    }
  }
  if (CURRENCY_SIGNS.includes(unsigned[unsigned.length - 1])) {
    const number = readNumber(unsigned.slice(0, -1).trim());
    if (number && number.value >= 0) {
      return { value: negative ? -number.value : number.value, format: `#,##0.00 ${unsigned[unsigned.length - 1]}` };
    }
  }

  const date = parseDateText(text);
  if (date) {
    if (date.kind === 'time') return { value: date.serial, format: /:\d\d:\d\d/.test(text) ? 'hh:mm:ss' : 'hh:mm' };
    const dayPattern = /^\d{1,2}\.\d/.test(text) ? 'd.m.yyyy' : /^\d{1,2}\/\d/.test(text) ? 'm/d/yyyy' : 'yyyy-mm-dd';
    return { value: date.serial, format: date.kind === 'date' ? dayPattern : `${dayPattern} hh:mm` };
  }
  return { value: input };
}

/** The text to edit for a stored value: typing it back gives the same value. */
export function editTextOf(value: number | string | boolean | null, pattern?: string): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    const kind = formatKind(pattern);
    if (kind === 'date' && Number.isInteger(value) && value >= 0) return formatValue(value, pattern === 'd.m.yyyy' || pattern === 'm/d/yyyy' ? pattern : 'yyyy-mm-dd');
    if (kind === 'dateTime' && value >= 0) return formatValue(value, 'yyyy-mm-dd hh:mm:ss');
    if (kind === 'time' && value >= 0 && value < 1) return formatValue(value, 'hh:mm:ss');
    if (kind === 'percent') return `${numberToText(roundTo(value * 100, 10))}%`;
    return numberToText(value);
  }
  if (pattern === TEXT_FORMAT) return value;
  // Text that would be read as something else keeps its meaning behind an apostrophe.
  const reparsed = parseInput(value);
  const needsMark = value.startsWith('=') || value.startsWith("'") || typeof reparsed.value !== 'string';
  return needsMark ? `'${value}` : value;
}

export { textToNumber };
