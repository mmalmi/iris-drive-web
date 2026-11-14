/**
 * Keeps every formula's value up to date.
 *
 * Each formula knows the cells and ranges it reads. When cells change, only
 * the formulas that read them, and the ones reading those, are marked as
 * waiting and calculated again. A waiting formula that another one reads is
 * calculated first, there and then; when such a chain gets too deep for
 * that, it is walked without recursion instead. A formula that depends on
 * itself gets #CYCLE! instead of running for ever.
 *
 * Values that formulas and the screen read are kept by position, so adding
 * up a long column does not look every cell up by name each time.
 */
import { rectContains, type Rect } from './address';
import {
  FormulaSyntaxError,
  VOLATILE_FUNCTIONS,
  callsAny,
  collectNames,
  collectRefs,
  evaluateFormula,
  parseFormula,
  type EvalHost,
  type Node,
  type RefSpec,
} from './formula';
import { NUMBER_FORMATS, formatKind, formatValue, type NumberLocale } from './format';
import { linkTarget } from './links';
import { cellKey, decodeRaw, isFormula, type Book, type BookChange, type Sheet } from './model';
import { nameRef, resolveName } from './names';
import { resolveRef } from './refs';
import { SheetError, err, isError, type Scalar } from './values';

const CLEAN = 0;
const DIRTY = 1;
const VISITING = 2;
/** How many formulas may wait on each other before the walk without recursion takes over. */
const MAX_NESTING = 120;

/** Thrown to unwind a chain of formulas that is too deep to calculate by recursion. */
class TooDeep extends Error {}

function cycleError(): SheetError {
  return err('#CYCLE!', 'This formula depends on its own result');
}

interface FormulaCell {
  sheet: Sheet;
  key: string;
  rowId: string;
  colId: string;
  stored: string;
  node: Node | null;
  syntaxError: SheetError | null;
  refs: RefSpec[];
  /** Named ranges the formula uses, as written. */
  names: string[];
  volatile: boolean;
  value: Scalar;
  /** A number format the formula implies, such as a date for =TODAY(). */
  format: string | undefined;
  state: number;
  inCycle: boolean;
  /** Where the walk through this formula's precedents has got to. */
  pending: FormulaCell[] | null;
}

interface RangeWatch {
  ref: RefSpec;
  formula: FormulaCell;
  epoch: number;
  target: { sheet: Sheet; rect: Rect } | null;
}

const DATE_RESULT = new Set(['DATE', 'TODAY', 'EDATE', 'EOMONTH', 'DATEVALUE', 'WORKDAY']);
/** Functions whose answer looks like one of their arguments: which argument. */
const SAME_AS_ARGUMENT: Record<string, number> = {
  SUM: 0, AVERAGE: 0, AVG: 0, MIN: 0, MAX: 0, MEDIAN: 0, MODE: 0, LARGE: 0, SMALL: 0,
  ROUND: 0, ROUNDUP: 0, ROUNDDOWN: 0, TRUNC: 0, INT: 0, ABS: 0, MROUND: 0, CEILING: 0, FLOOR: 0,
  IFERROR: 0, IFNA: 0, IF: 1, INDEX: 0, XLOOKUP: 2, LOOKUP: 2,
  SUMIFS: 0, AVERAGEIFS: 0, MAXIFS: 0, MINIFS: 0, SUMIF: 2, AVERAGEIF: 2,
  PMT: 2, FV: 2, PV: 2,
};

export class Engine {
  private readonly book: Book;
  private readonly formulas = new Map<string, Map<string, FormulaCell>>();
  private readonly cellWatchers = new Map<string, Set<FormulaCell>>();
  private readonly rangeWatchers = new Map<string, Set<RangeWatch>>();
  private readonly volatile = new Set<FormulaCell>();
  /** Formulas that use named ranges, read again when names change. */
  private readonly named = new Set<FormulaCell>();
  private dirty: FormulaCell[] = [];
  /** Goes up whenever rows, columns or sheets move, so cached positions are worked out again. */
  private epoch = 0;
  /** Values by sheet, row and column position; a missing entry has not been read yet. */
  private readonly grids = new Map<string, Array<Array<Scalar | undefined> | undefined>>();
  /** The formulas being calculated right now, each one read by the next. */
  private nesting: FormulaCell[] = [];
  /** True while a deep chain is walked without recursion. */
  private walking = false;
  private readonly host: EvalHost;
  private readonly unsubscribe: () => void;
  /** How many formulas have been calculated so far. */
  computed = 0;
  /** For tests: the clock and the dice. */
  now: () => Date = () => new Date();
  random: () => number = Math.random;

  constructor(book: Book) {
    this.book = book;
    this.host = {
      resolve: (ref, homeSheetId) => {
        const found = resolveRef(ref, this.book, this.book.sheet(homeSheetId));
        return found instanceof SheetError ? found : { sheetId: found.sheet.id, rect: found.rect };
      },
      cell: (sheetId, row, col) => {
        const cached = this.grids.get(sheetId)?.[row]?.[col];
        return cached !== undefined ? cached : this.valueAt(this.book.sheet(sheetId), row, col);
      },
      named: (name) => {
        const found = resolveName(this.book, name);
        return found === null || found instanceof SheetError ? found : { sheetId: found.sheet.id, rect: found.rect };
      },
      locale: () => this.book.numberLocale,
      now: () => this.now(),
      random: () => this.random(),
    };
    for (const info of book.sheets) this.loadSheet(book.sheet(info.id));
    this.recalculate();
    this.unsubscribe = book.onChange(change => this.applyChange(change));
  }

  destroy(): void {
    this.unsubscribe();
  }

  // --- Reading ---

  valueAt(sheet: Sheet, row: number, col: number): Scalar {
    let grid = this.grids.get(sheet.id);
    if (!grid) this.grids.set(sheet.id, grid = []);
    const cached = grid[row]?.[col];
    if (cached !== undefined) return cached;
    const rowId = sheet.rows.ids[row];
    const colId = sheet.cols.ids[col];
    if (rowId === undefined || colId === undefined) return null;
    const key = cellKey(rowId, colId);
    const formula = this.formulas.get(sheet.id)?.get(key);
    let value: Scalar;
    if (!formula) {
      value = decodeRaw(sheet.cells.get(key));
    } else {
      if (formula.state === VISITING) {
        // Being calculated further up: everything from there to here goes round in a circle.
        for (let index = this.nesting.lastIndexOf(formula); index >= 0 && index < this.nesting.length; index += 1) {
          this.nesting[index].inCycle = true;
        }
        return cycleError();
      }
      if (formula.state === DIRTY) this.ensure(formula);
      value = formula.value;
    }
    (grid[row] ??= [])[col] = value;
    return value;
  }

  /** Forgets the value kept for one cell. */
  private forget(sheet: Sheet, rowId: string, colId: string): void {
    const cells = this.grids.get(sheet.id)?.[sheet.rows.indexOf(rowId)];
    if (cells) cells[sheet.cols.indexOf(colId)] = undefined;
  }

  /** The number format in effect: the cell's own, or the one its formula implies. */
  formatAt(sheet: Sheet, row: number, col: number): string | undefined {
    const own = sheet.styleAt(row, col).nf;
    if (own) return own;
    const rowId = sheet.rows.ids[row];
    const colId = sheet.cols.ids[col];
    if (rowId === undefined || colId === undefined) return undefined;
    return this.formulas.get(sheet.id)?.get(cellKey(rowId, colId))?.format;
  }

  /** The text the cell shows. */
  textAt(sheet: Sheet, row: number, col: number): string {
    const value = this.valueAt(sheet, row, col);
    if (value === null) return '';
    return formatValue(value, this.formatAt(sheet, row, col), this.book.numberLocale);
  }

  /** Where the cell links to: the web address it holds, or the one its HYPERLINK formula names. */
  linkAt(sheet: Sheet, row: number, col: number): string | null {
    const value = this.valueAt(sheet, row, col);
    if (typeof value !== 'string' || value === '') return null;
    const rowId = sheet.rows.ids[row];
    const colId = sheet.cols.ids[col];
    const node = rowId === undefined || colId === undefined ? null : this.formulas.get(sheet.id)?.get(cellKey(rowId, colId))?.node;
    if (node?.t === 'call' && node.name === 'HYPERLINK' && node.args[0]) {
      try {
        const target = evaluateFormula(node.args[0], this.host, { sheetId: sheet.id, row, col });
        return typeof target === 'string' ? linkTarget(target, true) : null;
      } catch {
        return null;
      }
    }
    return linkTarget(value);
  }

  /** How numbers and dates are written in this spreadsheet. */
  get locale(): NumberLocale {
    return this.book.numberLocale;
  }

  // --- Following changes ---

  private applyChange(change: BookChange): void {
    let everything = change.sheets;
    for (const info of this.book.sheets) {
      if (!this.formulas.has(info.id)) {
        this.loadSheet(this.book.sheet(info.id));
        everything = true;
      }
    }
    // Names may have changed: formulas that use them watch the cells they stand for now.
    if (change.sheets) for (const formula of [...this.named]) this.register(formula.sheet, formula.key, true, true);
    const changed: Array<{ sheet: Sheet; key: string }> = [];
    for (const [sheetId, sheetChange] of change.bySheet) {
      const sheet = this.book.sheet(sheetId);
      if (!this.formulas.has(sheetId)) this.loadSheet(sheet);
      if (sheetChange.axes) everything = true;
      for (const key of sheetChange.cells) {
        const at = key.indexOf(':');
        this.forget(sheet, key.slice(0, at), key.slice(at + 1));
        this.register(sheet, key);
        changed.push({ sheet, key });
      }
    }
    if (everything) {
      this.epoch += 1;
      this.markAllDirty();
    } else {
      let ranges = 0;
      for (const watchers of this.rangeWatchers.values()) ranges += watchers.size;
      if (changed.length * ranges > 2_000_000) {
        this.markAllDirty();
      } else {
        for (const { sheet, key } of changed) this.markDependentsDirty(sheet, key);
      }
    }
    this.recalculate();
  }

  private loadSheet(sheet: Sheet): void {
    this.formulas.set(sheet.id, new Map());
    for (const [key, raw] of sheet.cells.entries()) {
      // Everything is calculated after loading, so nothing needs telling.
      if (isFormula(raw)) this.register(sheet, key, false);
    }
  }

  private watchKey(sheetId: string, key: string): string {
    return `${sheetId}|${key}`;
  }

  /** Reads the cell's stored content again and updates what is known about its formula. */
  private register(sheet: Sheet, key: string, tellDependents = true, again = false): void {
    const formulas = this.formulas.get(sheet.id) as Map<string, FormulaCell>;
    const raw = sheet.cells.get(key);
    const existing = formulas.get(key);
    if (existing) {
      if (existing.stored === raw && !again) return;
      this.unwatch(existing);
      formulas.delete(key);
      this.volatile.delete(existing);
      this.named.delete(existing);
    }
    if (!isFormula(raw)) return;
    const at = key.indexOf(':');
    const formula: FormulaCell = {
      sheet,
      key,
      rowId: key.slice(0, at),
      colId: key.slice(at + 1),
      stored: raw,
      node: null,
      syntaxError: null,
      refs: [],
      names: [],
      volatile: false,
      value: null,
      format: undefined,
      state: CLEAN,
      inCycle: false,
      pending: null,
    };
    try {
      formula.node = parseFormula(raw, 'id');
      formula.refs = collectRefs(formula.node).filter(ref => ref.resolved);
      formula.names = collectNames(formula.node);
      // A name is watched like the reference it stands for.
      for (const name of formula.names) {
        const ref = nameRef(this.book, name);
        if (ref) formula.refs.push(ref);
      }
      formula.volatile = callsAny(formula.node, VOLATILE_FUNCTIONS);
    } catch (error) {
      if (!(error instanceof FormulaSyntaxError)) throw error;
      formula.syntaxError = err('#ERROR!', error.message);
    }
    formulas.set(key, formula);
    if (formula.volatile) this.volatile.add(formula);
    if (formula.names.length > 0) this.named.add(formula);
    for (const ref of formula.refs) {
      const targetId = ref.sheet ?? sheet.id;
      if (ref.b === null && ref.a.row !== null && ref.a.col !== null) {
        const watchKey = this.watchKey(targetId, cellKey(ref.a.row, ref.a.col));
        let watchers = this.cellWatchers.get(watchKey);
        if (!watchers) this.cellWatchers.set(watchKey, watchers = new Set());
        watchers.add(formula);
      } else {
        let watchers = this.rangeWatchers.get(targetId);
        if (!watchers) this.rangeWatchers.set(targetId, watchers = new Set());
        watchers.add({ ref, formula, epoch: -1, target: null });
      }
    }
    if (tellDependents) {
      this.markDirty(formula);
    } else {
      formula.state = DIRTY;
      this.dirty.push(formula);
    }
  }

  private unwatch(formula: FormulaCell): void {
    for (const ref of formula.refs) {
      const targetId = ref.sheet ?? formula.sheet.id;
      if (ref.b === null && ref.a.row !== null && ref.a.col !== null) {
        this.cellWatchers.get(this.watchKey(targetId, cellKey(ref.a.row, ref.a.col)))?.delete(formula);
      } else {
        const watchers = this.rangeWatchers.get(targetId);
        if (watchers) for (const watch of watchers) if (watch.formula === formula) watchers.delete(watch);
      }
    }
  }

  private rangeTarget(watch: RangeWatch): { sheet: Sheet; rect: Rect } | null {
    if (watch.epoch !== this.epoch) {
      const found = resolveRef(watch.ref, this.book, watch.formula.sheet);
      watch.target = found instanceof SheetError ? null : found;
      watch.epoch = this.epoch;
    }
    return watch.target;
  }

  private markAllDirty(): void {
    this.grids.clear();
    for (const formulas of this.formulas.values()) {
      for (const formula of formulas.values()) {
        if (formula.state === CLEAN) {
          formula.state = DIRTY;
          this.dirty.push(formula);
        }
      }
    }
  }

  private markDirty(start: FormulaCell): void {
    const stack = [start];
    while (stack.length > 0) {
      const formula = stack.pop() as FormulaCell;
      if (formula.state !== CLEAN) continue;
      formula.state = DIRTY;
      this.dirty.push(formula);
      this.forget(formula.sheet, formula.rowId, formula.colId);
      this.collectDependents(formula.sheet, formula.key, formula.rowId, formula.colId, stack);
    }
  }

  private markDependentsDirty(sheet: Sheet, key: string): void {
    const at = key.indexOf(':');
    const stack: FormulaCell[] = [];
    this.collectDependents(sheet, key, key.slice(0, at), key.slice(at + 1), stack);
    for (const formula of stack) this.markDirty(formula);
  }

  private collectDependents(sheet: Sheet, key: string, rowId: string, colId: string, into: FormulaCell[]): void {
    const direct = this.cellWatchers.get(this.watchKey(sheet.id, key));
    if (direct) for (const formula of direct) if (formula.state === CLEAN) into.push(formula);
    const ranges = this.rangeWatchers.get(sheet.id);
    if (!ranges || ranges.size === 0) return;
    const row = sheet.rows.indexOf(rowId);
    const col = sheet.cols.indexOf(colId);
    if (row < 0 || col < 0) return;
    for (const watch of ranges) {
      if (watch.formula.state !== CLEAN) continue;
      const target = this.rangeTarget(watch);
      if (target && rectContains(target.rect, row, col)) into.push(watch.formula);
    }
  }

  // --- Calculating ---

  /** Formulas this one reads that still wait to be calculated. */
  private precedents(formula: FormulaCell): FormulaCell[] {
    const found: FormulaCell[] = [];
    for (const ref of formula.refs) {
      const target = resolveRef(ref, this.book, formula.sheet);
      if (target instanceof SheetError) continue;
      const formulas = this.formulas.get(target.sheet.id);
      if (!formulas || formulas.size === 0) continue;
      const { rect, sheet } = target;
      const area = (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
      if (area <= formulas.size * 2) {
        for (let row = rect.r1; row <= rect.r2; row += 1) {
          for (let col = rect.c1; col <= rect.c2; col += 1) {
            const other = formulas.get(cellKey(sheet.rows.ids[row], sheet.cols.ids[col]));
            if (other && other.state !== CLEAN) found.push(other);
          }
        }
      } else {
        for (const other of formulas.values()) {
          if (other.state === CLEAN) continue;
          if (rectContains(rect, sheet.rows.indexOf(other.rowId), sheet.cols.indexOf(other.colId))) found.push(other);
        }
      }
    }
    return found;
  }

  /**
   * Calculates a waiting formula. Waiting formulas it reads are calculated on
   * the way, by coming back here.
   */
  private ensure(formula: FormulaCell): void {
    if (formula.state !== DIRTY) return;
    if (!this.walking && this.nesting.length >= MAX_NESTING) throw new TooDeep();
    const outermost = this.nesting.length === 0;
    formula.state = VISITING;
    formula.inCycle = false;
    this.nesting.push(formula);
    try {
      this.compute(formula);
      this.nesting.pop();
    } catch (error) {
      if (!(error instanceof TooDeep) || !outermost) throw error;
      // Start over for this formula, one step at a time.
      for (const waiting of this.nesting) waiting.state = DIRTY;
      this.nesting = [];
      this.walking = true;
      try {
        this.settle(formula);
      } finally {
        this.walking = false;
        this.nesting = [];
      }
    }
  }

  /**
   * Calculates a formula after everything it could read, without deep
   * recursion. Whether formulas really go round in a circle is found out as
   * in `ensure`: by one of them reading a formula that is still on the way.
   */
  private settle(start: FormulaCell): void {
    const stack = this.nesting;
    stack.push(start);
    while (stack.length > 0) {
      const formula = stack[stack.length - 1];
      if (formula.state === CLEAN) {
        stack.pop();
        continue;
      }
      if (formula.state === DIRTY) {
        formula.state = VISITING;
        formula.inCycle = false;
        formula.pending = this.precedents(formula);
      }
      const next = (formula.pending as FormulaCell[]).pop();
      if (next === undefined) {
        this.compute(formula);
        stack.pop();
      } else if (next.state === DIRTY) {
        stack.push(next);
      }
    }
  }

  private compute(formula: FormulaCell): void {
    formula.pending = null;
    const row = formula.sheet.rows.indexOf(formula.rowId);
    const col = formula.sheet.cols.indexOf(formula.colId);
    let value: Scalar;
    if (formula.inCycle) {
      value = cycleError();
    } else if (formula.syntaxError || !formula.node) {
      value = formula.syntaxError ?? err('#ERROR!');
    } else if (row < 0 || col < 0) {
      value = null;
    } else {
      try {
        value = evaluateFormula(formula.node, this.host, { sheetId: formula.sheet.id, row, col });
      } catch (error) {
        if (error instanceof TooDeep) throw error;
        // A fault in a function must not take the rest of the spreadsheet down with it.
        console.error('[Sheets] Could not calculate a formula:', error);
        value = err('#ERROR!', 'This formula could not be calculated');
      }
      // Reading its own cells again on the way marks the formula as part of a circle.
      if (formula.inCycle) value = cycleError();
    }
    formula.value = value;
    formula.format = typeof formula.value === 'number' && formula.node ? this.impliedFormat(formula.node, formula.sheet) : undefined;
    formula.state = CLEAN;
    this.computed += 1;
  }

  /** Brings every waiting formula up to date. */
  recalculate(): void {
    for (const formula of this.volatile) this.markDirty(formula);
    const waiting = this.dirty;
    this.dirty = [];
    for (const formula of waiting) {
      if (formula.state === DIRTY) this.ensure(formula);
    }
  }

  /** Whether any formula's answer depends on the time or on chance. */
  get hasVolatile(): boolean {
    return this.volatile.size > 0;
  }

  // --- Formats that follow from the formula ---

  private impliedFormat(node: Node, home: Sheet): string | undefined {
    switch (node.t) {
      case 'ref': {
        const target = resolveRef(node.ref, this.book, home);
        if (target instanceof SheetError) return undefined;
        const { sheet, rect } = target;
        const format = this.formatAt(sheet, rect.r1, rect.c1);
        // A column of amounts under a text heading still means amounts.
        if (!format && rect.r2 > rect.r1) return this.formatAt(sheet, rect.r1 + 1, rect.c1);
        return format;
      }
      case 'un':
        return this.impliedFormat(node.x, home);
      case 'bin': {
        const left = this.impliedFormat(node.l, home);
        const right = this.impliedFormat(node.r, home);
        const kind = (format: string | undefined) => formatKind(format);
        const isDate = (format: string | undefined) => kind(format) === 'date' || kind(format) === 'dateTime';
        if (node.op === '+') return left ?? right;
        if (node.op === '-') return isDate(left) && isDate(right) ? undefined : left ?? (isDate(right) ? undefined : right);
        if (node.op === '*') return kind(left) === 'currency' ? left : kind(right) === 'currency' ? right : undefined;
        if (node.op === '/') return kind(left) === 'currency' && kind(right) !== 'currency' ? left : undefined;
        return undefined;
      }
      case 'call': {
        if (DATE_RESULT.has(node.name)) return NUMBER_FORMATS.date;
        if (node.name === 'NOW') return NUMBER_FORMATS.dateTime;
        if (node.name === 'TIME' || node.name === 'TIMEVALUE') return 'hh:mm:ss';
        const index = SAME_AS_ARGUMENT[node.name];
        if (index === undefined) return undefined;
        const arg = node.args[index] ?? (node.name === 'SUMIF' || node.name === 'AVERAGEIF' ? node.args[0] : undefined);
        const format = arg ? this.impliedFormat(arg, home) : undefined;
        if (!format && node.name === 'IF' && node.args[2]) return this.impliedFormat(node.args[2], home);
        return format;
      }
      default:
        return undefined;
    }
  }

  /** The sentence that explains an error in a cell, if it has one. */
  messageAt(sheet: Sheet, row: number, col: number): string {
    const value = this.valueAt(sheet, row, col);
    return isError(value) ? value.message : '';
  }
}
