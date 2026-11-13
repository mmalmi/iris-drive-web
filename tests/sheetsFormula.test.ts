import { describe, expect, it } from 'vitest';
import { columnIndex } from '../src/lib/sheets/address';
import { serialFromYmd } from '../src/lib/sheets/dates';
import { evaluateFormula, parseFormula, tokenize, type EvalHost, type RefSpec } from '../src/lib/sheets/formula';
import { SheetError, isError, type Scalar } from '../src/lib/sheets/values';

type Cells = Record<string, string | number | boolean>;

/** A tiny spreadsheet addressed by position, enough to try formulas on. */
function sheet(cells: Cells) {
  const cache = new Map<string, Scalar>();
  const key = (row: number, col: number) => `${row},${col}`;
  const raw = new Map<string, string | number | boolean>();
  for (const [name, value] of Object.entries(cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(name) as RegExpExecArray;
    raw.set(key(Number(match[2]) - 1, columnIndex(match[1])), value);
  }
  const host: EvalHost = {
    resolve(ref: RefSpec) {
      if (ref.sheet) return new SheetError('#REF!');
      const end = ref.b ?? ref.a;
      return {
        sheetId: 's',
        rect: {
          r1: ref.a.row === null ? 0 : Number(ref.a.row) - 1,
          c1: ref.a.col === null ? 0 : columnIndex(ref.a.col),
          r2: end.row === null ? 99 : Number(end.row) - 1,
          c2: end.col === null ? 25 : columnIndex(end.col),
        },
      };
    },
    cell(_sheet, row, col) {
      const id = key(row, col);
      if (cache.has(id)) return cache.get(id) as Scalar;
      const value = raw.get(id);
      if (typeof value !== 'string' || !value.startsWith('=')) return value ?? null;
      cache.set(id, new SheetError('#CYCLE!'));
      const result = evaluateFormula(parseFormula(value, 'a1'), host, { sheetId: 's', row, col });
      cache.set(id, result);
      return result;
    },
    now: () => new Date(2026, 10, 13, 9, 30, 0),
    random: () => 0.5,
  };
  return (formula: string, at = { row: 50, col: 20 }): Scalar | string => {
    const result = evaluateFormula(parseFormula(formula, 'a1'), host, { sheetId: 's', ...at });
    return isError(result) ? result.code : result;
  };
}

const calc = (formula: string, cells: Cells = {}) => sheet(cells)(formula);

describe('reading formulas', () => {
  it('splits a formula into tokens and keeps every character', () => {
    const text = 'SUM( A1:B2 , $C$3)*2 & "a""b" + Costs!D4 - \'My sheet\'!E:E';
    const tokens = tokenize(text, 'a1');
    expect(tokens.map(token => token.text).join('')).toBe(text);
    const refs = tokens.filter(token => token.type === 'ref').map(token => token.ref);
    expect(refs).toHaveLength(4);
    expect(refs[1]).toMatchObject({ sheet: null, a: { col: 'C', row: '3', absCol: true, absRow: true }, b: null });
    expect(refs[2]).toMatchObject({ sheet: 'Costs', a: { col: 'D', row: '4' } });
    expect(refs[3]).toMatchObject({ sheet: 'My sheet', a: { col: 'E', row: null }, b: { col: 'E', row: null } });
  });

  it('reads stored references by id', () => {
    const tokens = tokenize('SUM([a1,7]:[b2,$k9])+[s2!$c,r]+A1', 'id');
    const refs = tokens.filter(token => token.type === 'ref').map(token => token.ref);
    expect(refs[0]).toMatchObject({ sheet: null, a: { col: 'a1', row: '7' }, b: { col: 'b2', row: 'k9', absRow: true }, resolved: true });
    expect(refs[1]).toMatchObject({ sheet: 's2', a: { col: 'c', row: 'r', absCol: true }, resolved: true });
    expect(refs[2]).toMatchObject({ resolved: false });
  });

  it('tells functions from cells', () => {
    expect(tokenize('LOG10(A1)+LOG10', 'a1').map(token => token.type)).toEqual(['func', 'open', 'ref', 'close', 'op', 'ref']);
  });

  it('rejects what it cannot read', () => {
    expect(() => parseFormula('=1+', 'a1')).toThrow();
    expect(() => parseFormula('=SUM(1', 'a1')).toThrow();
    expect(() => parseFormula('=1 2', 'a1')).toThrow();
    expect(() => parseFormula('="open', 'a1')).toThrow();
  });
});

describe('arithmetic', () => {
  it('follows the usual order of operations', () => {
    expect(calc('=1+2*3')).toBe(7);
    expect(calc('=(1+2)*3')).toBe(9);
    expect(calc('=2^3^2')).toBe(64);
    expect(calc('=-2^2')).toBe(4);
    expect(calc('=10-4-3')).toBe(3);
    expect(calc('=50%*200')).toBe(100);
    expect(calc('=1.5e2+.5')).toBe(150.5);
  });

  it('does not show binary rounding noise', () => {
    expect(calc('=0.1+0.2')).toBe(0.3);
    expect(calc('=SUM(0.1,0.2,0.3)')).toBe(0.6);
    expect(calc('=1.1*3-3.3')).toBe(0);
  });

  it('joins and compares', () => {
    expect(calc('="a"&1&TRUE')).toBe('a1TRUE');
    expect(calc('="Apple"="apple"')).toBe(true);
    expect(calc('=2>=3')).toBe(false);
    expect(calc('=1<>2')).toBe(true);
    expect(calc('="10">9')).toBe(true);
  });

  it('reports errors by name', () => {
    expect(calc('=1/0')).toBe('#DIV/0!');
    expect(calc('="a"*2')).toBe('#VALUE!');
    expect(calc('=NOSUCH(1)')).toBe('#NAME?');
    expect(calc('=frog+1')).toBe('#NAME?');
    expect(calc('=SQRT(-1)')).toBe('#NUM!');
    expect(calc('=#N/A')).toBe('#N/A');
    expect(calc('=Other!A1')).toBe('#REF!');
    expect(calc('=A1+1', { A1: '=1/0' })).toBe('#DIV/0!');
    expect(calc('=IF()')).toBe('#N/A');
  });

  it('treats empty cells as zero or empty text', () => {
    expect(calc('=A1+1')).toBe(1);
    expect(calc('=A1&"x"')).toBe('x');
    expect(calc('=A1')).toBe(null);
    expect(calc('=A1=0')).toBe(true);
  });
});

describe('functions', () => {
  const cells: Cells = {
    A1: 'Item', B1: 'Price', C1: 'Qty', D1: 'Kind',
    A2: 'Apple', B2: 1.2, C2: 10, D2: 'fruit',
    A3: 'Bread', B3: 2.5, C3: 4, D3: 'bakery',
    A4: 'Cherry', B4: 8, C4: 2, D4: 'fruit',
    A5: 'Donut', B5: 0.9, C5: 12, D5: 'bakery',
    A6: 'Egg', B6: 'n/a', C6: 30, D6: 'dairy',
  };
  const f = sheet(cells);

  it('adds up and counts', () => {
    expect(f('=SUM(B2:B6)')).toBe(12.6);
    expect(f('=SUM(B2:B5,10,"5")')).toBe(27.6);
    expect(f('=COUNT(B2:B6)')).toBe(4);
    expect(f('=COUNTA(B2:B6)')).toBe(5);
    expect(f('=COUNTBLANK(A1:E2)')).toBe(2);
    expect(f('=AVERAGE(C2:C6)')).toBe(11.6);
    expect(f('=MIN(C:C)')).toBe(2);
    expect(f('=MAX(2:2)')).toBe(10);
    expect(f('=MEDIAN(C2:C6)')).toBe(10);
    expect(f('=PRODUCT(C3:C4)')).toBe(8);
    expect(f('=SUMPRODUCT(B2:B5,C2:C5)')).toBe(48.8);
    expect(f('=SUMPRODUCT(B2:B5*C2:C5)')).toBe(48.8);
    expect(f('=SUMPRODUCT((D2:D6="fruit")*C2:C6)')).toBe(12);
    expect(f('=LARGE(C2:C6,2)')).toBe(12);
    expect(f('=SMALL(C2:C6,1)')).toBe(2);
    expect(f('=RANK(10,C2:C6)')).toBe(3);
    expect(f('=ROUND(STDEV(C2:C6),4)')).toBe(11.0815);
  });

  it('rounds', () => {
    expect(calc('=ROUND(2.5)')).toBe(3);
    expect(calc('=ROUND(1.005,2)')).toBe(1.01);
    expect(calc('=ROUND(-2.5)')).toBe(-3);
    expect(calc('=ROUND(1234.5,-2)')).toBe(1200);
    expect(calc('=ROUNDUP(1.21,1)')).toBe(1.3);
    expect(calc('=ROUNDDOWN(-1.29,1)')).toBe(-1.2);
    expect(calc('=INT(-1.5)')).toBe(-2);
    expect(calc('=TRUNC(-1.5)')).toBe(-1);
    expect(calc('=MOD(-1,3)')).toBe(2);
    expect(calc('=CEILING(4.1,0.5)')).toBe(4.5);
    expect(calc('=FLOOR(4.4,0.5)')).toBe(4);
    expect(calc('=MROUND(7,5)')).toBe(5);
    expect(calc('=ABS(-3)+SIGN(-9)+POWER(2,10)')).toBe(1026);
  });

  it('counts and sums on conditions', () => {
    expect(f('=COUNTIF(D2:D6,"fruit")')).toBe(2);
    expect(f('=COUNTIF(C2:C6,">=10")')).toBe(3);
    expect(f('=COUNTIF(A2:A6,"*r*")')).toBe(2);
    expect(f('=COUNTIF(B2:B6,"<>n/a")')).toBe(4);
    expect(f('=SUMIF(D2:D6,"bakery",C2:C6)')).toBe(16);
    expect(f('=SUMIF(C2:C6,">5")')).toBe(52);
    expect(f('=SUMIFS(C2:C6,D2:D6,"fruit",B2:B6,">2")')).toBe(2);
    expect(f('=AVERAGEIF(D2:D6,"fruit",B2:B6)')).toBe(4.6);
    expect(f('=AVERAGEIFS(C2:C6,D2:D6,"bakery")')).toBe(8);
    expect(f('=COUNTIFS(D2:D6,"fruit",C2:C6,">5")')).toBe(1);
    expect(f('=MAXIFS(B2:B6,D2:D6,"bakery")')).toBe(2.5);
    expect(f('=MINIFS(C2:C6,D2:D6,"fruit")')).toBe(2);
    expect(f('=AVERAGEIF(D2:D6,"nothing",B2:B6)')).toBe('#DIV/0!');
    expect(f('=COUNTIF(C2:C6,10)')).toBe(1);
  });

  it('decides', () => {
    expect(f('=IF(C2>5,"many","few")')).toBe('many');
    expect(f('=IF(C4>5,"many")')).toBe(false);
    expect(f('=IF(TRUE,1,1/0)')).toBe(1);
    expect(f('=IFS(C4>5,"many",C4>1,"some",TRUE,"none")')).toBe('some');
    expect(f('=IFERROR(1/0,"oops")')).toBe('oops');
    expect(f('=IFERROR(B6*2,0)')).toBe(0);
    expect(f('=IFERROR(4,0)')).toBe(4);
    expect(f('=IFNA(VLOOKUP("Zebra",A2:B6,2,FALSE),"missing")')).toBe('missing');
    expect(f('=AND(C2>5,C3>5)')).toBe(false);
    expect(f('=OR(C2>5,C3>5)')).toBe(true);
    expect(f('=NOT(C2>5)')).toBe(false);
    expect(f('=XOR(TRUE,TRUE,TRUE)')).toBe(true);
    expect(f('=SWITCH(D3,"fruit",1,"bakery",2,0)')).toBe(2);
    expect(f('=CHOOSE(2,"a","b","c")')).toBe('b');
    expect(f('=ISBLANK(E9)&ISNUMBER(B2)&ISTEXT(A2)&ISERROR(1/0)&ISNA(NA())')).toBe('TRUETRUETRUETRUETRUE');
  });

  it('looks things up', () => {
    expect(f('=VLOOKUP("Cherry",A2:D6,2,FALSE)')).toBe(8);
    expect(f('=VLOOKUP("cherry",A2:D6,4,0)')).toBe('fruit');
    expect(f('=VLOOKUP("Zebra",A2:D6,2,FALSE)')).toBe('#N/A');
    expect(f('=VLOOKUP("Cherry",A2:D6,9,FALSE)')).toBe('#REF!');
    expect(f('=VLOOKUP("Coconut",A2:D6,2)')).toBe(8);
    expect(f('=VLOOKUP("Ch*",A2:D6,3,FALSE)')).toBe(2);
    expect(f('=HLOOKUP("Qty",A1:D6,3,FALSE)')).toBe(4);
    expect(f('=MATCH("Donut",A2:A6,0)')).toBe(4);
    expect(f('=MATCH(9,C1:C1,0)')).toBe('#N/A');
    expect(f('=INDEX(A2:D6,2,1)')).toBe('Bread');
    expect(f('=INDEX(B2:B6,MATCH("Donut",A2:A6,0))')).toBe(0.9);
    expect(f('=INDEX(A1:D1,3)')).toBe('Qty');
    expect(f('=SUM(INDEX(A2:D6,0,3))')).toBe(58);
    expect(f('=INDEX(A2:D6,9,1)')).toBe('#REF!');
    expect(f('=XLOOKUP("Bread",A2:A6,C2:C6)')).toBe(4);
    expect(f('=XLOOKUP("Zebra",A2:A6,C2:C6,"none")')).toBe('none');
    expect(f('=XLOOKUP("Zebra",A2:A6,C2:C6)')).toBe('#N/A');
    expect(f('=XLOOKUP(5,C2:C6,A2:A6,,-1)')).toBe('Bread');
    expect(f('=XLOOKUP(5,C2:C6,A2:A6,,1)')).toBe('Apple');
    expect(f('=XLOOKUP("fruit",D2:D6,A2:A6,,0,-1)')).toBe('Cherry');
    expect(f('=XMATCH("Egg",A2:A6)')).toBe(5);
    expect(f('=LOOKUP(5,C4:C5,A4:A5)')).toBe('Cherry');
    expect(f('=ROW(B7)+COLUMN(B7)')).toBe(9);
    expect(f('=ROWS(A2:D6)*COLUMNS(A2:D6)')).toBe(20);
    expect(f('=ROW()', { row: 4, col: 0 })).toBe(5);
    expect(f('=ADDRESS(2,3)')).toBe('$C$2');
  });

  it('picks the value in its own row from a whole column', () => {
    expect(f('=C:C*2', { row: 2, col: 7 })).toBe(8);
  });

  it('works with text', () => {
    expect(calc('=LEFT("Spreadsheet",6)&RIGHT("Spreadsheet",5)&MID("Spreadsheet",7,2)')).toBe('Spreadsheetsh');
    expect(calc('=LEN("héllo")')).toBe(5);
    expect(calc('=UPPER("a")&LOWER("B")&PROPER("mary o\'neil-smith")')).toBe("AbMary O'neil-Smith");
    expect(calc('=TRIM("  a   b  ")')).toBe('a b');
    expect(calc('=SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(calc('=SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c');
    expect(calc('=REPLACE("abcdef",2,3,"X")')).toBe('aXef');
    expect(calc('=FIND("b","abcabc",3)')).toBe(5);
    expect(calc('=SEARCH("B?A","abcabcab")')).toBe(2);
    expect(calc('=FIND("z","abc")')).toBe('#VALUE!');
    expect(calc('=CONCATENATE("a",1,TRUE)')).toBe('a1TRUE');
    expect(calc('=TEXTJOIN(", ",TRUE,A1:A4)', { A1: 'x', A3: 'y', A4: 3 })).toBe('x, y, 3');
    expect(calc('=REPT("ab",3)')).toBe('ababab');
    expect(calc('=EXACT("a","A")')).toBe(false);
    expect(calc('=VALUE("1,234.5")+VALUE("50%")')).toBe(1235);
    expect(calc('=TEXT(1234.567,"#,##0.00")')).toBe('1,234.57');
    expect(calc('=TEXT(0.256,"0%")')).toBe('26%');
    expect(calc('=TEXT(DATE(2026,11,13),"d mmm yyyy")')).toBe('13 Nov 2026');
    expect(calc('=CHAR(65)&CODE("a")')).toBe('A97');
  });

  it('works with dates', () => {
    const day = (y: number, m: number, d: number) => serialFromYmd(y, m, d);
    expect(calc('=DATE(2026,11,13)')).toBe(day(2026, 11, 13));
    expect(calc('=DATE(1900,1,1)')).toBe(2);
    expect(calc('=TODAY()')).toBe(day(2026, 11, 13));
    expect(calc('=NOW()-TODAY()')).toBeCloseTo(9.5 / 24, 6);
    expect(calc('=YEAR(A1)&"-"&MONTH(A1)&"-"&DAY(A1)', { A1: day(2024, 2, 29) })).toBe('2024-2-29');
    expect(calc('=WEEKDAY(DATE(2026,11,13))')).toBe(6);
    expect(calc('=WEEKDAY(DATE(2026,11,13),2)')).toBe(5);
    expect(calc('=EDATE(DATE(2026,1,31),1)')).toBe(day(2026, 2, 28));
    expect(calc('=EOMONTH(DATE(2026,11,13),0)')).toBe(day(2026, 11, 30));
    expect(calc('=DATEDIF(DATE(2020,3,15),DATE(2026,11,13),"Y")')).toBe(6);
    expect(calc('=DATEDIF(DATE(2020,3,15),DATE(2026,11,13),"YM")')).toBe(7);
    expect(calc('=DAYS(DATE(2026,12,25),DATE(2026,11,13))')).toBe(42);
    expect(calc('=DATE(2026,12,25)-DATE(2026,11,13)')).toBe(42);
    expect(calc('=NETWORKDAYS(DATE(2026,11,9),DATE(2026,11,20))')).toBe(10);
    expect(calc('=WORKDAY(DATE(2026,11,13),1)')).toBe(day(2026, 11, 16));
    expect(calc('=ISOWEEKNUM(DATE(2026,1,1))')).toBe(1);
    expect(calc('=ISOWEEKNUM(DATE(2027,1,1))')).toBe(53);
    expect(calc('=HOUR(0.75)&":"&MINUTE(0.75)')).toBe('18:0');
    expect(calc('=DATEVALUE("2026-11-13")')).toBe(day(2026, 11, 13));
    expect(calc('=YEAR("13.11.2026")')).toBe(2026);
  });

  it('works out loan payments', () => {
    expect(calc('=ROUND(PMT(0.05/12,360,200000),2)')).toBe(-1073.64);
    expect(calc('=ROUND(FV(0.06/12,120,-100),2)')).toBe(16387.93);
    expect(calc('=ROUND(NPV(0.1,100,100,100),2)')).toBe(248.69);
  });
});
