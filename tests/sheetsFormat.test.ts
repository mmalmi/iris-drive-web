import { describe, expect, it } from 'vitest';
import { cellName, columnIndex, columnName, parseRectName, quoteSheetName, rectName } from '../src/lib/sheets/address';
import { parseDateText, partsFromSerial, serialFromYmd } from '../src/lib/sheets/dates';
import { planFill } from '../src/lib/sheets/fill';
import {
  NUMBER_FORMATS,
  changeDecimals,
  editTextOf,
  formatGeneral,
  formatKind,
  formatValue,
  parseInput,
  roundTo,
} from '../src/lib/sheets/format';
import { callAt, completionAt } from '../src/lib/sheets/formula/docs';
import { AxisLayout, hitTest, panesOf, scrollToShow, type Viewport } from '../src/lib/sheets/layout';
import { parseClipboardTable, parseCsv, writeClipboardTable, writeCsv } from '../src/lib/sheets/table';
import { SheetError } from '../src/lib/sheets/values';

describe('cell names', () => {
  it('converts between letters and positions', () => {
    expect(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'].map(columnIndex)).toEqual([0, 25, 26, 51, 52, 701, 702]);
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    expect(cellName(6, 1)).toBe('B7');
    expect(rectName({ r1: 0, c1: 0, r2: 8, c2: 2 })).toBe('A1:C9');
    expect(parseRectName('c9:a1')).toEqual({ r1: 0, c1: 0, r2: 8, c2: 2 });
    expect(parseRectName(' $B$7 ')).toEqual({ r1: 6, c1: 1, r2: 6, c2: 1 });
    expect(parseRectName('hello')).toBeNull();
    expect(parseRectName('A0')).toBeNull();
  });

  it('quotes sheet names that need it', () => {
    expect(quoteSheetName('Costs')).toBe('Costs');
    expect(quoteSheetName('Costs 2026')).toBe("'Costs 2026'");
    expect(quoteSheetName("Ann's")).toBe("'Ann''s'");
    expect(quoteSheetName('A1')).toBe("'A1'");
    expect(quoteSheetName('2026')).toBe("'2026'");
  });
});

describe('dates', () => {
  it('numbers days the way other spreadsheets do', () => {
    expect(serialFromYmd(1899, 12, 30)).toBe(0);
    expect(serialFromYmd(1970, 1, 1)).toBe(25569);
    expect(serialFromYmd(2026, 11, 13)).toBe(46339);
    expect(partsFromSerial(46339.75)).toMatchObject({ year: 2026, month: 11, day: 13, hour: 18, minute: 0, weekday: 5 });
    expect(partsFromSerial(0.999999)).toMatchObject({ day: 31, hour: 0, minute: 0, second: 0 });
  });

  it('reads dates as people type them', () => {
    const day = serialFromYmd(2026, 11, 13);
    for (const text of ['2026-11-13', '2026/11/13', '11/13/2026', '13.11.2026', '13 Nov 2026', '13 November 2026', 'Nov 13, 2026', '13.11.26']) {
      expect(parseDateText(text), text).toEqual({ serial: day, kind: 'date' });
    }
    expect(parseDateText('2026-11-13 18:30')).toEqual({ serial: day + 0.770_833_333_333_333_3, kind: 'datetime' });
    expect(parseDateText('2026-11-13T06:00:00')?.serial).toBe(day + 0.25);
    expect(parseDateText('6:30 pm')).toEqual({ serial: 18.5 / 24, kind: 'time' });
    expect(parseDateText('2026-02-30')).toBeNull();
    expect(parseDateText('13/13/2026')).toBeNull();
    expect(parseDateText('25:00')).toBeNull();
    expect(parseDateText('1/2')).toBeNull();
    expect(parseDateText('version 2026-11-13')).toBeNull();
  });
});

describe('showing values', () => {
  it('shows plain numbers without noise', () => {
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(1 / 3)).toBe('0.3333333333');
    expect(formatGeneral(1234567.891)).toBe('1234567.891');
    expect(formatGeneral(-0.5)).toBe('-0.5');
    expect(formatGeneral(1e21)).toBe('1E+21');
    expect(formatGeneral(1.5e-12)).toBe('1.5E-12');
    expect(formatGeneral(100)).toBe('100');
  });

  it('applies number formats', () => {
    expect(formatValue(1234.5, NUMBER_FORMATS.number)).toBe('1,234.50');
    expect(formatValue(-1234.567, NUMBER_FORMATS.number)).toBe('-1,234.57');
    expect(formatValue(0.1256, NUMBER_FORMATS.percent)).toBe('12.56%');
    expect(formatValue(1234.5, NUMBER_FORMATS.dollar)).toBe('$1,234.50');
    expect(formatValue(-3, NUMBER_FORMATS.euro)).toBe('-€3.00');
    expect(formatValue(1234567, '#,##0')).toBe('1,234,567');
    expect(formatValue(0.5, '0.00')).toBe('0.50');
    expect(formatValue(0.5, '#.##')).toBe('.5');
    expect(formatValue(5, '000')).toBe('005');
    expect(formatValue(1234567, '0.0,,"M"')).toBe('1.2M');
    expect(formatValue(12345, '0.00E+00')).toBe('1.23E+04');
    expect(formatValue(-5, '0.00;(0.00)')).toBe('(5.00)');
    expect(formatValue(0, '0.00;-0.00;"zero"')).toBe('zero');
    expect(formatValue(2.5, '0.0 "kg"')).toBe('2.5 kg');
    expect(formatValue(1.005, '0.00')).toBe('1.01');
    expect(formatValue(-0.001, '0.00')).toBe('0.00');
    expect(formatValue(1234.5, '[$€-407]#,##0.00')).toBe('€1,234.50');
  });

  it('applies date formats', () => {
    const moment = serialFromYmd(2026, 3, 7) + (14 * 3600 + 5 * 60 + 9) / 86_400;
    expect(formatValue(moment, 'yyyy-mm-dd')).toBe('2026-03-07');
    expect(formatValue(moment, 'd.m.yyyy')).toBe('7.3.2026');
    expect(formatValue(moment, 'm/d/yy')).toBe('3/7/26');
    expect(formatValue(moment, 'dddd, d mmmm yyyy')).toBe('Saturday, 7 March 2026');
    expect(formatValue(moment, 'ddd d mmm')).toBe('Sat 7 Mar');
    expect(formatValue(moment, 'hh:mm:ss')).toBe('14:05:09');
    expect(formatValue(moment, 'h:mm AM/PM')).toBe('2:05 PM');
    expect(formatValue(moment, 'yyyy-mm-dd hh:mm')).toBe('2026-03-07 14:05');
  });

  it('leaves text, TRUE/FALSE and errors alone', () => {
    expect(formatValue('hello', NUMBER_FORMATS.number)).toBe('hello');
    expect(formatValue(true, NUMBER_FORMATS.percent)).toBe('TRUE');
    expect(formatValue(new SheetError('#DIV/0!'), NUMBER_FORMATS.number)).toBe('#DIV/0!');
    expect(formatValue(null, NUMBER_FORMATS.number)).toBe('');
    expect(formatValue(42, '@')).toBe('42');
  });

  it('knows what kind a format is and changes its decimals', () => {
    expect(formatKind(undefined)).toBe('auto');
    expect(formatKind('@')).toBe('text');
    expect(formatKind('0.0%')).toBe('percent');
    expect(formatKind('#,##0.00 €')).toBe('currency');
    expect(formatKind('d.m.yyyy')).toBe('date');
    expect(formatKind('hh:mm')).toBe('time');
    expect(formatKind('yyyy-mm-dd hh:mm')).toBe('dateTime');
    expect(changeDecimals('#,##0.00', 1, 0)).toBe('#,##0.000');
    expect(changeDecimals('#,##0.00', -2, 0)).toBe('#,##0');
    expect(changeDecimals('0.00%', -1, 0)).toBe('0.0%');
    expect(changeDecimals('$#,##0.00', -3, 0)).toBe('$#,##0');
    expect(changeDecimals('#,##0.00 €', 1, 0)).toBe('#,##0.000 €');
    expect(changeDecimals(undefined, 1, 2.5)).toBe('0.00');
    expect(changeDecimals(undefined, -1, 2.5)).toBe('0');
    expect(changeDecimals('yyyy-mm-dd', 1, 0)).toBe('yyyy-mm-dd');
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(-2.5, 0)).toBe(-3);
  });
});

describe('typed input', () => {
  it('recognises numbers, money, percentages, dates and TRUE/FALSE', () => {
    expect(parseInput('42')).toEqual({ value: 42 });
    expect(parseInput(' -3.50 ')).toEqual({ value: -3.5 });
    expect(parseInput('1e3')).toEqual({ value: 1000 });
    expect(parseInput('1,234,567.5')).toEqual({ value: 1234567.5, format: '#,##0.0' });
    expect(parseInput('1,5')).toEqual({ value: 1.5 });
    expect(parseInput('12.5%')).toEqual({ value: 0.125, format: '0.0%' });
    expect(parseInput('$1,200')).toEqual({ value: 1200, format: '$#,##0.00' });
    expect(parseInput('-€5.5')).toEqual({ value: -5.5, format: '€#,##0.00' });
    expect(parseInput('20 €')).toEqual({ value: 20, format: '#,##0.00 €' });
    expect(parseInput('true')).toEqual({ value: true });
    expect(parseInput('2026-11-13')).toEqual({ value: 46339, format: 'yyyy-mm-dd' });
    expect(parseInput('13.11.2026')).toEqual({ value: 46339, format: 'd.m.yyyy' });
    expect(parseInput('11/13/2026')).toEqual({ value: 46339, format: 'm/d/yyyy' });
    expect(parseInput('9:30')).toEqual({ value: 9.5 / 24, format: 'hh:mm' });
  });

  it('keeps everything else as text', () => {
    for (const text of ['hello', '12 apples', '1.2.3', '+', '-', '.', '1,23,4', '$', '5%%', '=', ' ']) {
      expect(parseInput(text), text).toEqual({ value: text });
    }
    expect(parseInput("'42")).toEqual({ value: '42' });
    expect(parseInput('42', '@')).toEqual({ value: '42' });
    expect(parseInput('')).toEqual({ value: null });
  });

  it('gives back text that types to the same value', () => {
    expect(editTextOf(0.125, '0.0%')).toBe('12.5%');
    expect(editTextOf(46339, 'yyyy-mm-dd')).toBe('2026-11-13');
    expect(editTextOf(46339, 'd.m.yyyy')).toBe('13.11.2026');
    expect(editTextOf(46339.5, 'yyyy-mm-dd hh:mm')).toBe('2026-11-13 12:00:00');
    expect(editTextOf(1234.5, '$#,##0.00')).toBe('1234.5');
    expect(editTextOf('42')).toBe("'42");
    expect(editTextOf('true')).toBe("'true");
    expect(editTextOf('hello')).toBe('hello');
    expect(editTextOf("'quoted")).toBe("''quoted");
    expect(editTextOf(true)).toBe('TRUE');
    expect(editTextOf('42', '@')).toBe('42');
  });
});

describe('tables as text', () => {
  it('reads what other spreadsheets put on the clipboard', () => {
    expect(parseClipboardTable('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseClipboardTable('one')).toEqual([['one']]);
    expect(parseClipboardTable('"two\nlines"\t"say ""hi"""\n\tlast')).toEqual([['two\nlines', 'say "hi"'], ['', 'last']]);
    expect(parseClipboardTable('a\t\t\nb')).toEqual([['a', '', ''], ['b']]);
    expect(parseClipboardTable('5" pipe\tx')).toEqual([['5" pipe', 'x']]);
  });

  it('writes the clipboard so that it reads back the same', () => {
    const rows = [['plain', 'tab\there'], ['two\nlines', 'say "hi"'], ['', '']];
    expect(parseClipboardTable(writeClipboardTable(rows))).toEqual(rows);
    expect(writeClipboardTable([['a', 'b,c'], ['d', '']])).toBe('a\tb,c\nd\t');
  });

  it('reads and writes CSV files', () => {
    expect(parseCsv('﻿name,amount\n"Smith, J",5\n')).toEqual([['name', 'amount'], ['Smith, J', '5']]);
    expect(parseCsv('name;amount\r\nA;1,5\r\n')).toEqual([['name', 'amount'], ['A', '1,5']]);
    expect(parseCsv('a\tb\nc\td')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('')).toEqual([]);
    const rows = [['a', 'b,c', 'say "hi"'], ['two\nlines', '', 'z']];
    expect(parseCsv(writeCsv(rows))).toEqual(rows);
    expect(writeCsv([['a', 'b']])).toBe('a,b\r\n');
  });
});

describe('continuing a series', () => {
  const lane = (...values: Array<number | string>) => values.map(raw => ({ raw, isDate: false }));
  const values = (steps: ReturnType<typeof planFill>, source: Array<{ raw: unknown }>) => steps.map(step => step.value ?? source[step.source].raw);

  it('continues numbers that go up evenly and repeats the rest', () => {
    expect(values(planFill(lane(1, 2), 3), lane(1, 2))).toEqual([3, 4, 5]);
    expect(values(planFill(lane(10, 7.5), 2), lane(10, 7.5))).toEqual([5, 2.5]);
    expect(values(planFill(lane(5), 2), lane(5))).toEqual([5, 5]);
    expect(values(planFill(lane(1, 2, 4), 4), lane(1, 2, 4))).toEqual([1, 2, 4, 1]);
    expect(values(planFill(lane(0.1, 0.2), 1), lane(0.1, 0.2))).toEqual([0.3]);
  });

  it('counts dates in days', () => {
    const source = [{ raw: 46339, isDate: true }];
    expect(values(planFill(source, 2), source)).toEqual([46340, 46341]);
    expect(values(planFill(source, 2, true), source)).toEqual([46338, 46337]);
  });

  it('knows weekdays, months and numbered names', () => {
    expect(values(planFill(lane('Fri'), 3), lane('Fri'))).toEqual(['Sat', 'Sun', 'Mon']);
    expect(values(planFill(lane('monday'), 1), lane('monday'))).toEqual(['tuesday']);
    expect(values(planFill(lane('Nov'), 3), lane('Nov'))).toEqual(['Dec', 'Jan', 'Feb']);
    expect(values(planFill(lane('JAN', 'MAR'), 2), lane('JAN', 'MAR'))).toEqual(['MAY', 'JUL']);
    expect(values(planFill(lane('Item 9'), 2), lane('Item 9'))).toEqual(['Item 10', 'Item 11']);
    expect(values(planFill(lane('Q1', 'Q3'), 1), lane('Q1', 'Q3'))).toEqual(['Q5']);
    expect(values(planFill(lane('No. 007'), 1), lane('No. 007'))).toEqual(['No. 008']);
    expect(values(planFill(lane('Week 2'), 2, true), lane('Week 2'))).toEqual(['Week 1', 'Week 0']);
    expect(values(planFill(lane('a', 'b'), 3), lane('a', 'b'))).toEqual(['a', 'b', 'a']);
  });

  it('copies formulas and leaves moving their addresses to the caller', () => {
    const source = lane('=[a,b]+1', 5);
    expect(planFill(source, 3)).toEqual([{ source: 0 }, { source: 1 }, { source: 0 }]);
    expect(planFill(source, 3, true)).toEqual([{ source: 1 }, { source: 0 }, { source: 1 }]);
  });
});

describe('help while typing formulas', () => {
  it('offers functions that start with what is typed', () => {
    expect(completionAt('=su', 3)?.matches.map(doc => doc.name)).toEqual(['SUBSTITUTE', 'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT']);
    expect(completionAt('=A1+vl', 6)).toMatchObject({ start: 4, end: 6 });
    expect(completionAt('=A1', 3)).toBeNull();
    expect(completionAt('="su', 4)).toBeNull();
    expect(completionAt('=SUM(', 5)).toBeNull();
    expect(completionAt('=SUM(A1)', 4)).toBeNull();
    expect(completionAt('su', 2)).toBeNull();
    expect(completionAt('=zz', 3)).toBeNull();
  });

  it('knows which function and which value the caret is in', () => {
    expect(callAt('=VLOOKUP(A1, B:C, ', 18)).toMatchObject({ doc: { name: 'VLOOKUP' }, argument: 2 });
    expect(callAt('=IF(SUM(A1:A3)>2, "a,b", ', 25)).toMatchObject({ doc: { name: 'IF' }, argument: 2 });
    expect(callAt('=IF(SUM(A1', 10)).toMatchObject({ doc: { name: 'SUM' }, argument: 0 });
    expect(callAt('=SUM(A1)+', 9)).toBeNull();
    expect(callAt('=(1+', 4)).toBeNull();
  });
});

describe('positions on screen', () => {
  const view = (changes: Partial<Viewport> = {}): Viewport => ({
    rows: new AxisLayout(new Array(1000).fill(24)),
    cols: new AxisLayout(new Array(26).fill(100)),
    width: 846,
    height: 624,
    scrollX: 0,
    scrollY: 0,
    freezeRows: 0,
    freezeCols: 0,
    headerWidth: 46,
    ...changes,
  });

  it('finds rows and columns by distance', () => {
    const axis = new AxisLayout([10, 20, 30]);
    expect(axis.total).toBe(60);
    expect([0, 9, 10, 29, 30, 59, 60, 500, -5].map(offset => axis.indexAt(offset))).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 0]);
    expect(axis.start(2)).toBe(30);
    expect(axis.end(2)).toBe(60);
  });

  it('tells cells, headers and their borders apart', () => {
    expect(hitTest(view(), 10, 10).area).toBe('corner');
    expect(hitTest(view(), 190, 10)).toMatchObject({ area: 'colHeader', col: 1, colEdge: null });
    expect(hitTest(view(), 144, 10)).toMatchObject({ area: 'colHeader', col: 0, colEdge: 0 });
    expect(hitTest(view(), 148, 10)).toMatchObject({ area: 'colHeader', col: 1, colEdge: 0 });
    expect(hitTest(view(), 10, 50)).toMatchObject({ area: 'rowHeader', row: 1, rowEdge: 0 });
    expect(hitTest(view(), 150, 50)).toMatchObject({ area: 'cell', row: 1, col: 1 });
    expect(hitTest(view({ scrollX: 250, scrollY: 480 }), 150, 50)).toMatchObject({ area: 'cell', row: 21, col: 3 });
  });

  it('keeps frozen rows and columns in place', () => {
    const frozen = view({ freezeRows: 1, freezeCols: 1, scrollX: 300, scrollY: 2400 });
    expect(hitTest(frozen, 60, 30)).toMatchObject({ row: 0, col: 0 });
    expect(hitTest(frozen, 150, 30)).toMatchObject({ row: 0, col: 4 });
    expect(hitTest(frozen, 60, 50)).toMatchObject({ row: 101, col: 0 });
    const panes = panesOf(frozen);
    expect(panes).toHaveLength(4);
    expect(panes[0]).toMatchObject({ rowFrom: 0, rowTo: 0, colFrom: 0, colTo: 0, x: 46, y: 24 });
    expect(panes[3]).toMatchObject({ rowFrom: 101, colFrom: 4, x: 146, y: 48 });
  });

  it('scrolls just enough to show a cell', () => {
    expect(scrollToShow(view(), 5, 3)).toEqual({ scrollX: 0, scrollY: 0 });
    expect(scrollToShow(view(), 30, 0)).toEqual({ scrollX: 0, scrollY: 31 * 24 - 600 });
    expect(scrollToShow(view({ scrollY: 2400 }), 50, 0)).toEqual({ scrollX: 0, scrollY: 1200 });
    expect(scrollToShow(view(), 0, 10)).toEqual({ scrollX: 1100 - 800, scrollY: 0 });
    expect(scrollToShow(view({ freezeRows: 1, scrollY: 2400 }), 0, 0)).toEqual({ scrollX: 0, scrollY: 2400 });
    expect(scrollToShow(view({ freezeRows: 1, scrollY: 2400 }), 50, 0)).toEqual({ scrollX: 0, scrollY: 1176 });
  });
});
