/**
 * Conditional formats and data validation: rules over ranges of cells, kept
 * in the sheet's `rules` map, one entry per rule replaced whole. Two people
 * adding rules at once both keep theirs; two changing the same rule at once
 * end with one of the two versions. A range is kept by the ids of its first
 * and last rows and columns, so it follows rows and columns as they move.
 *
 * Everyone who opens the spreadsheet sees the formats, the checkboxes and
 * the lists; only someone who may edit can change the rules.
 */
import { rectContains, type Rect } from './address';
import type { Engine } from './engine';
import { NUMBER_FORMATS, formatValue, parseInput, type NumberLocale } from './format';
import { LOCAL_ORIGIN, newId, type CellStyle, type Sheet } from './model';
import { isError, type Scalar } from './values';

export interface RangeIds {
  r1: string;
  c1: string;
  r2: string;
  c2: string;
}

export type ConditionKind = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'outside' | 'contains' | 'notContains' | 'empty' | 'notEmpty';

export interface Condition {
  kind: ConditionKind;
  /** A number (dates are numbers) or text, as typed. */
  a?: number | string;
  b?: number | string;
}

/** The looks a conditional format gives. */
export type RuleStyle = Pick<CellStyle, 'bg' | 'c' | 'b' | 'i' | 's'>;

export interface FormatRule {
  type: 'format';
  range: RangeIds;
  when: Condition;
  style: RuleStyle;
  /** Rules earlier in order are applied first; the first that applies to a cell wins. */
  order: number;
}

export interface ScaleRule {
  type: 'scale';
  range: RangeIds;
  /** Colours for the lowest, middle (optional) and highest number. */
  colors: [string, string | null, string];
  order: number;
}

export type Check =
  | { kind: 'list'; items: string[] }
  | { kind: 'checkbox' }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'date'; min?: number; max?: number };

export interface ValidationRule {
  type: 'valid';
  range: RangeIds;
  check: Check;
  /** Refuse a value that does not fit, instead of only marking it. */
  reject: boolean;
  order: number;
}

export type Rule = FormatRule | ScaleRule | ValidationRule;
/** A rule before it has its place in the order. */
export type RuleDraft = Rule extends infer R ? (R extends Rule ? Omit<R, 'order'> & { order?: number } : never) : never;

export interface PlacedRule {
  id: string;
  rule: Rule;
  rect: Rect;
}

function isRule(value: unknown): value is Rule {
  const rule = value as Rule | null;
  return !!rule && (rule.type === 'format' || rule.type === 'scale' || rule.type === 'valid') && !!rule.range && typeof rule.range.r1 === 'string';
}

function rangeRect(sheet: Sheet, range: RangeIds): Rect | null {
  const rows = sheet.rows.span(range.r1, range.r2);
  const cols = sheet.cols.span(range.c1, range.c2);
  return rows && cols ? { r1: rows[0], r2: rows[1], c1: cols[0], c2: cols[1] } : null;
}

export function rangeIds(sheet: Sheet, rect: Rect): RangeIds {
  return { r1: sheet.rows.ids[rect.r1], c1: sheet.cols.ids[rect.c1], r2: sheet.rows.ids[rect.r2], c2: sheet.cols.ids[rect.c2] };
}

/** The sheet's rules in order, with where their ranges are now. */
export function listRules(sheet: Sheet): PlacedRule[] {
  const out: PlacedRule[] = [];
  for (const [id, value] of sheet.rules.entries()) {
    if (!isRule(value)) continue;
    const rect = rangeRect(sheet, value.range);
    if (rect) out.push({ id, rule: value, rect });
  }
  return out.sort((a, b) => a.rule.order - b.rule.order || (a.id < b.id ? -1 : 1));
}

export function addRule(sheet: Sheet, rule: RuleDraft): string {
  const id = newId();
  const order = rule.order ?? Math.max(0, ...listRules(sheet).map(placed => placed.rule.order)) + 1;
  sheet.rules.doc?.transact(() => sheet.rules.set(id, { ...rule, order } as Rule), LOCAL_ORIGIN);
  return id;
}

export function setRule(sheet: Sheet, id: string, rule: Rule): void {
  sheet.rules.doc?.transact(() => sheet.rules.set(id, rule), LOCAL_ORIGIN);
}

export function removeRule(sheet: Sheet, id: string): void {
  sheet.rules.doc?.transact(() => sheet.rules.delete(id), LOCAL_ORIGIN);
}

// --- Conditions ---

function isBlank(value: Scalar): boolean {
  return value === null || value === '';
}

function compare(value: Scalar, target: number | string | undefined): number | null {
  if (target === undefined || isBlank(value) || isError(value)) return null;
  if (typeof target === 'number') {
    const number = typeof value === 'number' ? value : typeof value === 'boolean' ? null : Number(value);
    return number === null || !Number.isFinite(number) ? null : number - target;
  }
  const text = String(value).toLowerCase();
  const other = target.toLowerCase();
  return text < other ? -1 : text > other ? 1 : 0;
}

export function matches(when: Condition, value: Scalar, text: string): boolean {
  const lower = text.toLowerCase();
  const needle = String(when.a ?? '').toLowerCase();
  switch (when.kind) {
    case 'empty': return isBlank(value);
    case 'notEmpty': return !isBlank(value);
    case 'contains': return needle !== '' && lower.includes(needle);
    case 'notContains': return needle === '' || !lower.includes(needle);
    default: break;
  }
  const first = compare(value, when.a);
  if (first === null) return when.kind === 'neq' && !isBlank(value);
  switch (when.kind) {
    case 'gt': return first > 0;
    case 'gte': return first >= 0;
    case 'lt': return first < 0;
    case 'lte': return first <= 0;
    case 'eq': return first === 0;
    case 'neq': return first !== 0;
    case 'between':
    case 'outside': {
      const second = compare(value, when.b);
      if (second === null) return false;
      // Between the two bounds, whichever is the smaller: on or past one, on or before the other.
      const inside = Math.sign(first) * Math.sign(second) <= 0;
      return when.kind === 'between' ? inside : !inside;
    }
    default: return false;
  }
}

/** A value typed into a rule's box: a number or date when it reads as one here, else text. */
export function readRuleValue(text: string, locale: NumberLocale): number | string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parsed = parseInput(trimmed, undefined, locale);
  return typeof parsed.value === 'number' ? parsed.value : trimmed;
}

/** A rule's value written back for its box. */
export function writeRuleValue(value: number | string | undefined, locale: NumberLocale, format?: string): string {
  if (value === undefined) return '';
  return typeof value === 'number' ? formatValue(value, format, locale) : value;
}

function mix(from: string, to: string, share: number): string {
  const parse = (hex: string) => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const a = parse(from);
  const b = parse(to);
  return `#${a.map((part, index) => Math.round(part + (b[index] - part) * share).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * How cells look with the conditional formats applied, worked out once per
 * change of the spreadsheet and kept while the grid draws.
 */
export class RuleLooks {
  private readonly sheet: Sheet;
  private readonly engine: Engine;
  private readonly rules: PlacedRule[];
  private readonly formats: PlacedRule[];
  private readonly scales = new Map<string, { low: number; middle: number; high: number }>();
  private readonly cache = new Map<number, CellStyle>();
  readonly validation: PlacedRule[];

  constructor(sheet: Sheet, engine: Engine) {
    this.sheet = sheet;
    this.engine = engine;
    this.rules = listRules(sheet);
    this.formats = this.rules.filter(placed => placed.rule.type !== 'valid');
    this.validation = this.rules.filter(placed => placed.rule.type === 'valid');
  }

  get empty(): boolean {
    return this.rules.length === 0;
  }

  private scaleOf(placed: PlacedRule): { low: number; middle: number; high: number } {
    let found = this.scales.get(placed.id);
    if (!found) {
      const numbers: number[] = [];
      const { rect } = placed;
      const used = this.engine.usedRect(this.sheet);
      const r2 = Math.min(rect.r2, used?.r2 ?? -1);
      const c2 = Math.min(rect.c2, used?.c2 ?? -1);
      for (let row = rect.r1; row <= r2; row += 1) {
        for (let col = rect.c1; col <= c2; col += 1) {
          const value = this.engine.valueAt(this.sheet, row, col);
          if (typeof value === 'number' && Number.isFinite(value)) numbers.push(value);
        }
      }
      numbers.sort((a, b) => a - b);
      const low = numbers[0] ?? 0;
      const high = numbers[numbers.length - 1] ?? 0;
      found = { low, high, middle: numbers.length ? (numbers[(numbers.length - 1) >> 1] + numbers[numbers.length >> 1]) / 2 : 0 };
      this.scales.set(placed.id, found);
    }
    return found;
  }

  /** The look of a cell: its own, with the first conditional format that applies laid over it. */
  look(row: number, col: number): CellStyle {
    const own = this.sheet.styleAt(row, col);
    if (this.formats.length === 0) return own;
    const key = row * 4096 + col;
    const cached = this.cache.get(key);
    if (cached) return cached;
    let out = own;
    for (const placed of this.formats) {
      if (!rectContains(placed.rect, row, col)) continue;
      const value = this.engine.valueAt(this.sheet, row, col);
      if (placed.rule.type === 'scale') {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const { low, middle, high } = this.scaleOf(placed);
        const [first, centre, last] = placed.rule.colors;
        let bg: string;
        if (high === low) bg = centre ?? first;
        else if (centre) bg = value <= middle ? mix(first, centre, middle === low ? 1 : (value - low) / (middle - low)) : mix(centre, last, high === middle ? 1 : (value - middle) / (high - middle));
        else bg = mix(first, last, (value - low) / (high - low));
        out = { ...own, bg };
        break;
      }
      if (placed.rule.type === 'format' && matches(placed.rule.when, value, this.engine.textAt(this.sheet, row, col))) {
        out = { ...own, ...placed.rule.style };
        break;
      }
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }

  /** The validation rule a cell is under, if any: the last one added wins where they overlap. */
  checkAt(row: number, col: number): ValidationRule | null {
    for (let index = this.validation.length - 1; index >= 0; index -= 1) {
      const placed = this.validation[index];
      if (rectContains(placed.rect, row, col)) return placed.rule as ValidationRule;
    }
    return null;
  }

  /** Whether a cell holds something its validation rule does not allow. */
  invalidAt(row: number, col: number): boolean {
    const rule = this.checkAt(row, col);
    if (!rule || rule.check.kind === 'checkbox') return false;
    const value = this.engine.valueAt(this.sheet, row, col);
    return !isBlank(value) && problemWith(rule.check, value, this.engine.textAt(this.sheet, row, col), this.engine.locale) !== null;
  }
}

/** The validation rule a cell is under, without building looks for the whole sheet. */
export function validationAt(sheet: Sheet, row: number, col: number): ValidationRule | null {
  let found: ValidationRule | null = null;
  for (const placed of listRules(sheet)) {
    if (placed.rule.type === 'valid' && rectContains(placed.rect, row, col)) found = placed.rule;
  }
  return found;
}

/** What is wrong with a value under a check, in a sentence; null when it fits. */
export function problemWith(check: Check, value: Scalar, text: string, locale: NumberLocale): string | null {
  switch (check.kind) {
    case 'list': {
      const wanted = text.trim().toLowerCase();
      return check.items.some(item => item.trim().toLowerCase() === wanted) ? null : `Choose one of: ${check.items.slice(0, 8).join(', ')}${check.items.length > 8 ? ', …' : ''}.`;
    }
    case 'checkbox':
      return typeof value === 'boolean' || value === null ? null : 'This cell is a checkbox.';
    case 'number':
    case 'date': {
      const what = check.kind === 'date' ? 'a date' : 'a number';
      const write = (n: number) => formatValue(n, check.kind === 'date' ? NUMBER_FORMATS.date : undefined, locale);
      const range = check.min !== undefined && check.max !== undefined
        ? ` from ${write(check.min)} to ${write(check.max)}`
        : check.min !== undefined ? ` of at least ${write(check.min)}` : check.max !== undefined ? ` of at most ${write(check.max)}` : '';
      if (typeof value !== 'number') return `Enter ${what}${range}.`;
      if ((check.min !== undefined && value < check.min) || (check.max !== undefined && value > check.max)) return `Enter ${what}${range}.`;
      return null;
    }
    default:
      return null;
  }
}
