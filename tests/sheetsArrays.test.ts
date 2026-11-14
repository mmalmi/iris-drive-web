import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { columnIndex, parseRectName } from '../src/lib/sheets/address';
import { copySelection, exportCsv, pasteText } from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { evaluateFormulaArray, parseFormula, type EvalHost, type RefSpec } from '../src/lib/sheets/formula';
import { importXlsx, readXlsx, writeXlsx } from '../src/lib/sheets/xlsx';
import { SheetError, isError, isMatrix, type Scalar } from '../src/lib/sheets/values';

type Cells = Record<string, string | number | boolean>;

/** A formula's result on a tiny sheet: rows of values, or one value; errors as their code. */
function calc(formula: string, cells: Cells = {}): unknown {
  const raw = new Map<string, Scalar>();
  for (const [name, value] of Object.entries(cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(name) as RegExpExecArray;
    raw.set(`${Number(match[2]) - 1},${columnIndex(match[1])}`, value);
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
          r2: end.row === null ? 9 : Number(end.row) - 1,
          c2: end.col === null ? 5 : columnIndex(end.col),
        },
      };
    },
    cell: (_sheet, row, col) => raw.get(`${row},${col}`) ?? null,
    now: () => new Date(2026, 10, 14),
    random: () => 0.5,
  };
  const show = (value: Scalar) => (isError(value) ? value.code : value);
  const result = evaluateFormulaArray(parseFormula(formula, 'a1'), host, { sheetId: 's', row: 50, col: 20 });
  if (!isMatrix(result)) return show(result);
  const rows: unknown[][] = [];
  for (let r = 0; r < result.rows; r += 1) {
    const row: unknown[] = [];
    for (let c = 0; c < result.cols; c += 1) row.push(show(result.get(r, c)));
    rows.push(row);
  }
  return rows;
}

const FRUIT: Cells = {
  A1: 'Apple', B1: 3, C1: 'red',
  A2: 'Pear', B2: 5, C2: 'green',
  A3: 'Apple', B3: 3, C3: 'red',
  A4: 'apple', B4: 1, C4: 'red',
  A5: 'Kiwi', B5: 8, C5: 'green',
};

describe('UNIQUE', () => {
  it('keeps the first of each row, capitals counting', () => {
    expect(calc('=UNIQUE(A1:A5)', FRUIT)).toEqual([['Apple'], ['Pear'], ['apple'], ['Kiwi']]);
    expect(calc('=UNIQUE(A1:C5)', FRUIT)).toEqual([['Apple', 3, 'red'], ['Pear', 5, 'green'], ['apple', 1, 'red'], ['Kiwi', 8, 'green']]);
  });

  it('keeps one empty row and tells numbers from text', () => {
    expect(calc('=UNIQUE(A1:A3)', { A1: 1, A2: '1' })).toEqual([[1], ['1'], [null]]);
  });

  it('compares columns, and keeps only what appears once', () => {
    expect(calc('=UNIQUE(A1:D1,TRUE)', { A1: 'x', B1: 'y', C1: 'x', D1: 'z' })).toEqual([['x', 'y', 'z']]);
    expect(calc('=UNIQUE(A1:A5,FALSE,TRUE)', FRUIT)).toEqual([['Pear'], ['apple'], ['Kiwi']]);
  });

  it('is #N/A when nothing appears once', () => {
    expect(calc('=UNIQUE(A1:A2,FALSE,TRUE)', { A1: 'x', A2: 'x' })).toBe('#N/A');
  });

  it('gives a single value on its own', () => {
    expect(calc('=UNIQUE(A1:A2)', { A1: 'x', A2: 'x' })).toBe('x');
  });
});

describe('FILTER', () => {
  it('keeps the rows that meet every condition', () => {
    expect(calc('=FILTER(A1:B5,B1:B5>2)', FRUIT)).toEqual([['Apple', 3], ['Pear', 5], ['Apple', 3], ['Kiwi', 8]]);
    expect(calc('=FILTER(A1:A5,B1:B5>2,C1:C5="green")', FRUIT)).toEqual([['Pear'], ['Kiwi']]);
    // Either of two conditions, by adding them.
    expect(calc('=FILTER(A1:A5,(A1:A5="Kiwi")+(B1:B5=1))', FRUIT)).toEqual([['apple'], ['Kiwi']]);
  });

  it('keeps columns with a condition as wide as the range', () => {
    expect(calc('=FILTER(A1:C2,A3:C3)', { A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6, A3: true, B3: false, C3: 1 })).toEqual([[1, 3], [4, 6]]);
  });

  it('is #N/A when nothing matches', () => {
    expect(calc('=FILTER(A1:A5,B1:B5>100)', FRUIT)).toBe('#N/A');
  });

  it('is #VALUE! when a condition is not the size of the range', () => {
    expect(calc('=FILTER(A1:A5,B1:B4>2)', FRUIT)).toBe('#VALUE!');
    expect(calc('=FILTER(A1:A5,B1:B5>2,C1:C3="red")', FRUIT)).toBe('#VALUE!');
  });
});

describe('SORT', () => {
  it('sorts by the first column, upwards, by default', () => {
    expect(calc('=SORT(A1:A5)', FRUIT)).toEqual([['Apple'], ['Apple'], ['apple'], ['Kiwi'], ['Pear']]);
  });

  it('sorts by other columns either way, keeping ties in order', () => {
    expect(calc('=SORT(A1:B5,2,FALSE)', FRUIT)).toEqual([['Kiwi', 8], ['Pear', 5], ['Apple', 3], ['Apple', 3], ['apple', 1]]);
    expect(calc('=SORT(A1:C5,3,TRUE,2,FALSE)', FRUIT)).toEqual([
      ['Kiwi', 8, 'green'], ['Pear', 5, 'green'], ['Apple', 3, 'red'], ['Apple', 3, 'red'], ['apple', 1, 'red'],
    ]);
  });

  it('sorts by a column outside the range', () => {
    expect(calc('=SORT(A1:A5,B1:B5,TRUE)', FRUIT)).toEqual([['apple'], ['Apple'], ['Apple'], ['Pear'], ['Kiwi']]);
  });

  it('puts empty cells last either way', () => {
    expect(calc('=SORT(A1:A4,1,FALSE)', { A1: 2, A3: 5, A4: 1 })).toEqual([[5], [2], [1], [null]]);
    expect(calc('=SORT(A1:A4)', { A1: 2, A3: 5, A4: 1 })).toEqual([[1], [2], [5], [null]]);
  });

  it('is #VALUE! for a column the range does not have', () => {
    expect(calc('=SORT(A1:B5,3,TRUE)', FRUIT)).toBe('#VALUE!');
    expect(calc('=SORT(A1:A5,B1:B3,TRUE)', FRUIT)).toBe('#VALUE!');
  });
});

describe('SEQUENCE', () => {
  it('counts across, then down', () => {
    expect(calc('=SEQUENCE(3)')).toEqual([[1], [2], [3]]);
    expect(calc('=SEQUENCE(2,3)')).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(calc('=SEQUENCE(2,2,10,-0.5)')).toEqual([[10, 9.5], [9, 8.5]]);
    expect(calc('=SEQUENCE(1,3,,2)')).toEqual([[1, 3, 5]]);
  });

  it('needs at least one row and column, and not too many', () => {
    expect(calc('=SEQUENCE(0)')).toBe('#VALUE!');
    expect(calc('=SEQUENCE(2,-1)')).toBe('#VALUE!');
    expect(calc('=SEQUENCE(100000,100)')).toBe('#NUM!');
  });
});

describe('TRANSPOSE', () => {
  it('turns rows into columns', () => {
    expect(calc('=TRANSPOSE(A1:B3)', { A1: 1, B1: 2, A2: 3, B2: 4, A3: 5, B3: 6 })).toEqual([[1, 3, 5], [2, 4, 6]]);
    expect(calc('=TRANSPOSE(A1)', { A1: 7 })).toBe(7);
  });
});

describe('SPLIT', () => {
  it('splits at each separator character, numbers becoming numbers', () => {
    expect(calc('=SPLIT("a,b;c",",;")')).toEqual([['a', 'b', 'c']]);
    expect(calc('=SPLIT("1, 2,,3",",")')).toEqual([[1, 2, 3]]);
  });

  it('can split at the whole separator and keep empty pieces', () => {
    expect(calc('=SPLIT("a--b-c","--",FALSE)')).toEqual([['a', 'b-c']]);
    expect(calc('=SPLIT("a,,b",",",TRUE,FALSE)')).toEqual([['a', '', 'b']]);
  });

  it('is #VALUE! without text or a separator', () => {
    expect(calc('=SPLIT("",",")')).toBe('#VALUE!');
    expect(calc('=SPLIT("a","")')).toBe('#VALUE!');
  });
});

describe('ARRAYFORMULA', () => {
  it('works out operators cell by cell', () => {
    expect(calc('=ARRAYFORMULA(B1:B3*2)', FRUIT)).toEqual([[6], [10], [6]]);
    expect(calc('=ARRAYFORMULA(A1:A2&" "&C1:C2)', FRUIT)).toEqual([['Apple red'], ['Pear green']]);
  });

  it('works out IF and IFERROR cell by cell', () => {
    expect(calc('=ARRAYFORMULA(IF(B1:B5>4,"big","small"))', FRUIT)).toEqual([['small'], ['big'], ['small'], ['small'], ['big']]);
    expect(calc('=ARRAYFORMULA(IF(A1:A3="",,A1:A3*2))', { A1: 1, A3: 3 })).toEqual([[2], [null], [6]]);
    expect(calc('=ARRAYFORMULA(IFERROR(1/A1:A3,"none"))', { A1: 1, A2: 0, A3: 4 })).toEqual([[1], ['none'], [0.25]]);
  });

  it('leaves formulas outside it as they were', () => {
    expect(calc('=IF(A1>0,"yes","no")', { A1: 1 })).toBe('yes');
    expect(calc('=SUM(UNIQUE(B1:B5))', FRUIT)).toBe(17);
  });
});

/** A spreadsheet with its controller, filled in the way a person types. */
function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  const at = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad cell name ${name}`);
    return { row: rect.r1, col: rect.c1 };
  };
  const select = (name: string) => {
    const rect = parseRectName(name) as NonNullable<ReturnType<typeof parseRectName>>;
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  const type = (name: string, text: string) => {
    select(name);
    if (text === '') {
      ctl.book.transact(() => ctl.sheet.setRaw(at(name).row, at(name).col, null));
      return;
    }
    ctl.startEdit({ text });
    ctl.commitEdit();
  };
  const get = (name: string) => {
    const { row, col } = at(name);
    const value = ctl.engine.valueAt(ctl.sheet, row, col);
    return isError(value) ? value.code : value;
  };
  const column = (name: string, rows: number) => {
    const { row, col } = at(name);
    const out: unknown[] = [];
    for (let r = row; r < row + rows; r += 1) {
      const value = ctl.engine.valueAt(ctl.sheet, r, col);
      out.push(isError(value) ? value.code : value);
    }
    return out;
  };
  const message = (name: string) => ctl.engine.messageAt(ctl.sheet, at(name).row, at(name).col);
  return { ctl, doc, select, type, get, column, message };
}

describe('filling cells with a result', () => {
  it('fills the cells below and beside, which hold nothing themselves', () => {
    const { ctl, type, get, column, select } = open();
    ['Pear', 'Apple', 'Pear', 'Fig'].forEach((fruit, index) => type(`A${index + 1}`, fruit));
    type('C1', '=UNIQUE(A1:A4)');
    expect(column('C1', 4)).toEqual(['Pear', 'Apple', 'Fig', null]);
    expect(ctl.sheet.rawAt(1, 2)).toBeUndefined();
    // The formula bar shows the formula whose result fills the cell.
    select('C2');
    expect(ctl.barText).toBe('=UNIQUE(A1:A4)');
    expect(ctl.barSource).toEqual({ row: 0, col: 2 });
    select('C1');
    expect(ctl.barSource).toBeNull();
    type('D1', '=SEQUENCE(2,3)');
    expect([get('D1'), get('E1'), get('F1'), get('D2'), get('F2')]).toEqual([1, 2, 3, 4, 6]);
  });

  it('follows changes to what it reads, growing and shrinking', () => {
    const { type, column } = open();
    ['Pear', 'Apple', 'Pear'].forEach((fruit, index) => type(`A${index + 1}`, fruit));
    type('C1', '=SORT(UNIQUE(A1:A3))');
    expect(column('C1', 3)).toEqual(['Apple', 'Pear', null]);
    type('A4', 'Banana');
    type('C1', '=SORT(UNIQUE(A1:A4))');
    expect(column('C1', 4)).toEqual(['Apple', 'Banana', 'Pear', null]);
    type('A2', 'Pear');
    expect(column('C1', 4)).toEqual(['Banana', 'Pear', null, null]);
  });

  it('can be read by other formulas, alone and in ranges', () => {
    const { type, get } = open();
    type('A1', '=SEQUENCE(4)');
    type('B1', '=A3*10');
    type('B2', '=SUM(A1:A10)');
    type('B3', '=SUM(A:A)');
    type('B4', '=COUNTA(A2:A4)');
    expect([get('B1'), get('B2'), get('B3'), get('B4')]).toEqual([30, 10, 10, 3]);
    type('A1', '=SEQUENCE(5,1,2)');
    expect([get('B1'), get('B2'), get('B3'), get('B4')]).toEqual([40, 20, 20, 3]);
    // One result read by another.
    type('C1', '=FILTER(A1:A5,A1:A5>3)');
    type('D1', '=SUM(C1:C9)');
    expect(get('D1')).toBe(15);
    type('A1', '=SEQUENCE(5,1,0)');
    expect(get('D1')).toBe(4);
  });

  it('shows #REF! and overwrites nothing when a cell is in the way', () => {
    const { ctl, type, get, column, message } = open();
    type('A1', '=SEQUENCE(3)');
    type('B1', '=SUM(A1:A3)');
    expect(get('B1')).toBe(6);
    type('A3', 'mine');
    expect(get('A1')).toBe('#REF!');
    expect(message('A1')).toBe('Array result was not expanded because it would overwrite data in A3.');
    expect(column('A1', 3)).toEqual(['#REF!', null, 'mine']);
    expect(ctl.sheet.rawAt(2, 0)).toBe('mine');
    expect(get('B1')).toBe('#REF!');
    // Clearing the way lets the result back.
    type('A3', '');
    expect(column('A1', 3)).toEqual([1, 2, 3]);
    expect(get('B1')).toBe(6);
  });

  it('shows #REF! at the edge of the sheet', () => {
    const { ctl, type, message } = open();
    const last = ctl.sheet.rows.length;
    type(`A${last - 1}`, '=SEQUENCE(4)');
    expect(message(`A${last - 1}`)).toContain('Add 2 more rows');
  });

  it('lets the first of two results that would cover the same cells win', () => {
    const { type, get, message } = open();
    type('B1', '=SEQUENCE(3)');
    type('A2', '=SEQUENCE(1,3)');
    expect(get('B1')).toBe(1);
    expect(get('B2')).toBe(2);
    expect(get('A2')).toBe('#REF!');
    expect(message('A2')).toContain('overwrite data in B2');
  });

  it('will not fill cells its formula reads', () => {
    const { type, get } = open();
    type('C5', '4');
    type('C1', '=SORT(C2:C5)');
    expect(get('C1')).toBe('#CYCLE!');
  });

  it('stores only the formula, and another device works out the same', () => {
    const first = open();
    first.type('A1', 'b,a,c');
    first.type('A2', '=TRANSPOSE(SPLIT(A1,","))');
    expect(first.column('A2', 3)).toEqual(['b', 'a', 'c']);
    expect([...first.ctl.sheet.cells.values()]).toEqual(['b,a,c', expect.stringMatching(/^=TRANSPOSE/)]);
    const second = open(new Y.Doc());
    Y.applyUpdate(second.doc, Y.encodeStateAsUpdate(first.doc), 'stored');
    second.ctl.showSheet(second.ctl.sheets[0].id);
    expect(second.column('A2', 3)).toEqual(['b', 'a', 'c']);
  });

  it('copies the formula with its cell, and values from the cells it fills', () => {
    const { ctl, type, select, get } = open();
    type('A1', '=SEQUENCE(3)');
    select('A1');
    copySelection(ctl);
    select('C1');
    pasteText(ctl, ctl.copied?.text ?? '');
    expect(ctl.sheet.rawAt(0, 2)).toMatch(/^=SEQUENCE/);
    expect([get('C1'), get('C2'), get('C3')]).toEqual([1, 2, 3]);
    select('A2:A3');
    copySelection(ctl);
    select('E1');
    pasteText(ctl, ctl.copied?.text ?? '');
    expect([ctl.sheet.rawAt(0, 4), ctl.sheet.rawAt(1, 4)]).toEqual([2, 3]);
  });

  it('exports the values to CSV and .xlsx', () => {
    const { ctl, type } = open();
    type('A1', '=SEQUENCE(2,2)');
    expect(exportCsv(ctl).trim().split(/\r?\n/)).toEqual(['1,2', '3,4']);
    const data = writeXlsx(ctl.book, ctl.engine);
    const xml = strFromU8(unzipSync(data)['xl/worksheets/sheet1.xml']);
    expect(xml).not.toContain('<f>');
    const [sheet] = readXlsx(data);
    expect([...sheet.cells.values()].map(cell => cell.value)).toEqual([1, 2, 3, 4]);
  });

  it('opens array formulas from Excel and Google Sheets as formulas that fill cells', () => {
    const head = '<?xml version="1.0" encoding="UTF-8"?>';
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const files = {
      'xl/workbook.xml': strToU8(`${head}<workbook ${ns}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="/xl/worksheets/data.xml"/></Relationships>`),
      'xl/worksheets/data.xml': strToU8(`${head}<worksheet ${ns}><sheetData>`
        // A dynamic array in B1:B2, and an older array formula in C1:C3.
        + '<row r="1"><c r="A1"><v>2</v></c><c r="B1" cm="1"><f t="array" ref="B1:B2">_xlfn.UNIQUE(A1:A3)</f><v>2</v></c><c r="C1"><f t="array" ref="C1:C3">A1:A3*10</f><v>20</v></c></row>'
        + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>5</v></c><c r="C2"><v>20</v></c></row>'
        + '<row r="3"><c r="A3"><v>5</v></c><c r="C3"><v>50</v></c></row>'
        + '</sheetData></worksheet>'),
    };
    const { ctl, get, column } = open();
    importXlsx(ctl, 'Arrays.xlsx', zipSync(files));
    expect(ctl.sheet.rawAt(0, 1)).toMatch(/^=UNIQUE\(/);
    expect(ctl.sheet.rawAt(0, 2)).toMatch(/^=ARRAYFORMULA\(/);
    expect(ctl.sheet.rawAt(1, 1)).toBeUndefined();
    expect([get('B1'), get('B2')]).toEqual([2, 5]);
    expect(column('C1', 3)).toEqual([20, 20, 50]);
  });
});
