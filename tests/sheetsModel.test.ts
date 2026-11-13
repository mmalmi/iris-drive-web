import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { editTextAt, writeInput } from '../src/lib/sheets/edit';
import { Engine } from '../src/lib/sheets/engine';
import { Book, DEFAULT_COLS, DEFAULT_ROWS, LOCAL_ORIGIN, type Sheet } from '../src/lib/sheets/model';
import { moveKeepingRanges } from '../src/lib/sheets/structure';
import { isError } from '../src/lib/sheets/values';

function open(doc = new Y.Doc()) {
  const book = new Book(doc);
  book.initialize();
  const engine = new Engine(book);
  const first = () => book.sheet(book.sheets[0].id);
  const at = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad cell name ${name}`);
    return { row: rect.r1, col: rect.c1 };
  };
  return {
    doc,
    book,
    engine,
    first,
    put(name: string, text: string, sheet: Sheet = first()) {
      const { row, col } = at(name);
      writeInput(book, sheet, row, col, text);
    },
    /** The calculated value, with errors as their code. */
    get(name: string, sheet: Sheet = first()) {
      const { row, col } = at(name);
      const value = engine.valueAt(sheet, row, col);
      return isError(value) ? value.code : value;
    },
    show(name: string, sheet: Sheet = first()) {
      const { row, col } = at(name);
      return engine.textAt(sheet, row, col);
    },
    typed(name: string, sheet: Sheet = first()) {
      const { row, col } = at(name);
      return editTextAt(book, sheet, row, col);
    },
  };
}

/** Carries each document's changes to the other, as saving and loading does. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'stored');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'stored');
}

describe('a new spreadsheet', () => {
  it('starts with one sheet of the usual size', () => {
    const { book, first } = open();
    expect(book.sheets).toEqual([{ id: '1', name: 'Sheet1' }]);
    expect(first().rows.length).toBe(DEFAULT_ROWS);
    expect(first().cols.length).toBe(DEFAULT_COLS);
    expect(book.meta.get('version')).toBe(1);
  });

  it('is one grid even when two devices start it at the same moment', () => {
    const a = open();
    const b = open();
    a.put('B2', 'from a');
    b.put('C3', 'from b');
    sync(a.doc, b.doc);
    for (const side of [a, b]) {
      expect(side.book.sheets).toHaveLength(1);
      expect(side.first().rows.length).toBe(DEFAULT_ROWS);
      expect(side.first().cols.length).toBe(DEFAULT_COLS);
      expect(side.get('B2')).toBe('from a');
      expect(side.get('C3')).toBe('from b');
    }
  });

  it('stays small', () => {
    const { doc, put } = open();
    for (let row = 1; row <= 100; row += 1) put(`A${row}`, String(row));
    expect(Y.encodeStateAsUpdate(doc).length).toBeLessThan(8000);
  });
});

describe('typing into cells', () => {
  it('keeps numbers, text, dates and percentages as what they are', () => {
    const { put, get, show, typed } = open();
    put('A1', '1,234.5');
    put('A2', '25%');
    put('A3', '2026-11-13');
    put('A4', '$12');
    put('A5', 'hello');
    put('A6', "'007");
    put('A7', 'true');
    put('A8', '13.11.2026');
    put('A9', "'=not a formula");
    expect(get('A1')).toBe(1234.5);
    expect(show('A1')).toBe('1,234.5');
    expect(get('A2')).toBe(0.25);
    expect(show('A2')).toBe('25%');
    expect(typed('A2')).toBe('25%');
    expect(show('A3')).toBe('2026-11-13');
    expect(typed('A3')).toBe('2026-11-13');
    expect(show('A4')).toBe('$12.00');
    expect(typed('A4')).toBe('12');
    expect(get('A5')).toBe('hello');
    expect(get('A6')).toBe('007');
    expect(typed('A6')).toBe("'007");
    expect(get('A7')).toBe(true);
    expect(show('A8')).toBe('13.11.2026');
    expect(get('A9')).toBe('=not a formula');
    expect(typed('A9')).toBe("'=not a formula");
    put('A5', '');
    expect(get('A5')).toBe(null);
  });

  it('calculates formulas and closes brackets left open', () => {
    const { put, get, typed } = open();
    put('A1', '2');
    put('A2', '3');
    put('A3', '=sum(a1:a2');
    expect(get('A3')).toBe(5);
    expect(typed('A3')).toBe('=SUM(A1:A2)');
    put('A1', '10');
    expect(get('A3')).toBe(13);
    put('B1', '=A3*$A$1+Sheet1!A2');
    expect(get('B1')).toBe(133);
    expect(typed('B1')).toBe('=A3*$A$1+Sheet1!A2');
  });

  it('shows results of date formulas as dates and of money formulas as money', () => {
    const { put, show, engine } = open();
    engine.now = () => new Date(2026, 10, 13, 8, 0, 0);
    put('A1', '=TODAY()');
    put('A2', '=A1+7');
    put('A3', '=A2-A1');
    put('B1', '$4.50');
    put('B2', '$5.25');
    put('B3', '=SUM(B1:B2)');
    put('B4', '=B3*2');
    put('B5', '=B3/B1');
    expect(show('A1')).toBe('11/13/2026');
    expect(show('A2')).toBe('11/20/2026');
    expect(show('A3')).toBe('7');
    expect(show('B3')).toBe('$9.75');
    expect(show('B4')).toBe('$19.50');
    expect(show('B5')).toBe('2.166666667');
  });

  it('gives a formula that reads itself an error instead of hanging', () => {
    const { put, get } = open();
    put('A1', '=A1+1');
    put('B1', '=B2');
    put('B2', '=B3');
    put('B3', '=B1');
    put('C1', '=B1+1');
    expect(get('A1')).toBe('#CYCLE!');
    expect(get('B1')).toBe('#CYCLE!');
    expect(get('B3')).toBe('#CYCLE!');
    expect(get('C1')).toBe('#CYCLE!');
    put('B3', '4');
    expect(get('B1')).toBe(4);
    expect(get('C1')).toBe(5);
  });

  it('reports what it cannot read', () => {
    const { put, get } = open();
    put('A1', '=1+');
    put('A2', '=Nowhere!A1');
    put('A3', '=ZZ1');
    expect(get('A1')).toBe('#ERROR!');
    expect(get('A2')).toBe('#REF!');
    expect(get('A3')).toBe('#REF!');
  });
});

describe('recalculation', () => {
  it('only works out the formulas that read what changed', () => {
    const { put, get, engine } = open();
    for (let row = 1; row <= 50; row += 1) {
      put(`A${row}`, String(row));
      put(`B${row}`, `=A${row}*2`);
    }
    put('C1', '=SUM(B1:B50)');
    put('D1', '=C1+1');
    expect(get('C1')).toBe(2550);
    const before = engine.computed;
    put('A7', '100');
    expect(get('D1')).toBe(2737);
    // B7, C1 and D1.
    expect(engine.computed - before).toBe(3);
  });

  it('follows a chain thousands of cells long', () => {
    const { book, first, get } = open();
    const sheet = first();
    book.transact(() => {
      sheet.setRaw(0, 0, 1);
      for (let row = 1; row < 1000; row += 1) sheet.setRaw(row, 0, `=[0,${sheet.rows.ids[row - 1]}]+1`);
      // The far end first, so the walk cannot rely on the order of typing.
      for (let col = 1; col < 20; col += 1) sheet.setRaw(999, col, `=[${sheet.cols.ids[col - 1]},${sheet.rows.ids[999]}]+1`);
    });
    expect(get('A1000')).toBe(1000);
    expect(get('T1000')).toBe(1019);
    sheet.setRaw(0, 0, 5);
    expect(get('T1000')).toBe(1023);
  });

  it('handles running totals, a long chain that also reads long ranges', () => {
    const { book, first, get } = open();
    const sheet = first();
    const row = (index: number) => sheet.rows.ids[index];
    book.transact(() => {
      for (let index = 0; index < 1000; index += 1) {
        sheet.setRaw(index, 0, index + 1);
        // B: a balance carried from the row above. C: everything so far added up again.
        sheet.setRaw(index, 1, index === 0 ? `=[0,${row(0)}]` : `=[1,${row(index - 1)}]+[0,${row(index)}]`);
        sheet.setRaw(index, 2, `=SUM([0,${row(0)}]:[0,${row(index)}])-[1,${row(index)}]`);
      }
    });
    expect(get('B1000')).toBe(500500);
    expect(get('C1000')).toBe(0);
    const started = performance.now();
    sheet.setRaw(0, 0, 11);
    expect(get('B1000')).toBe(500510);
    expect(get('C500')).toBe(0);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a formula that reads itself only through a branch it does not take is not a circle', () => {
    const { put, get } = open();
    put('A1', '5');
    put('B1', '=IF(A1>0,A1*2,B1)');
    expect(get('B1')).toBe(10);
    put('A1', '-1');
    expect(get('B1')).toBe('#CYCLE!');
    put('A1', '3');
    expect(get('B1')).toBe(6);
  });

  it('finds a circle at the end of a long chain too', () => {
    const { book, first, get, put } = open();
    const sheet = first();
    book.transact(() => {
      for (let index = 1; index < 400; index += 1) sheet.setRaw(index, 0, `=[0,${sheet.rows.ids[index - 1]}]+1`);
    });
    put('A1', '=IF(B1>0,1,A400)');
    put('B1', '1');
    expect(get('A400')).toBe(400);
    put('B1', '0');
    expect(get('A1')).toBe('#CYCLE!');
    expect(get('A400')).toBe('#CYCLE!');
    put('B1', '2');
    expect(get('A400')).toBe(400);
  });

  it('stays quick with a few thousand formulas', () => {
    const { book, first, get } = open();
    const sheet = first();
    const started = performance.now();
    book.transact(() => {
      for (let row = 0; row < 1000; row += 1) {
        sheet.setRaw(row, 0, row + 1);
        sheet.setRaw(row, 1, `=[0,${sheet.rows.ids[row]}]*2`);
        sheet.setRaw(row, 2, `=SUM([0,${sheet.rows.ids[0]}]:[1,${sheet.rows.ids[row]}])`);
        sheet.setRaw(row, 3, `=IF([2,${sheet.rows.ids[row]}]>1000,"big","small")`);
      }
    });
    expect(get('C1000')).toBe(1501500);
    const loaded = performance.now() - started;
    const edit = performance.now();
    sheet.setRaw(500, 0, 0);
    expect(get('C1000')).toBe(1501500 - 501 * 3);
    expect(performance.now() - edit).toBeLessThan(400);
    expect(loaded).toBeLessThan(3000);
  });
});

describe('rows and columns', () => {
  function budget() {
    const side = open();
    const { put } = side;
    put('A1', 'Rent');
    put('B1', '900');
    put('A2', 'Food');
    put('B2', '300');
    put('A3', 'Fun');
    put('B3', '100');
    put('A4', 'Total');
    put('B4', '=SUM(B1:B3)');
    put('D1', '=B2*2');
    return side;
  }

  it('formulas follow their cells when rows are inserted', () => {
    const { first, put, get, typed } = budget();
    first().insert('row', 1, 2);
    expect(get('A4')).toBe('Food');
    expect(typed('B6')).toBe('=SUM(B1:B5)');
    expect(get('B6')).toBe(1300);
    expect(typed('D1')).toBe('=B4*2');
    put('B2', '50');
    expect(get('B6')).toBe(1350);
  });

  it('formulas follow their cells when columns are inserted and moved', () => {
    const { book, first, get, typed } = budget();
    first().insert('col', 0, 1);
    expect(typed('C4')).toBe('=SUM(C1:C3)');
    moveKeepingRanges(book, first(), 'col', 2, 1, 0);
    expect(get('A1')).toBe(900);
    expect(get('C1')).toBe('Rent');
    expect(typed('A4')).toBe('=SUM(A1:A3)');
    expect(typed('E1')).toBe('=A2*2');
    expect(get('A4')).toBe(1300);
  });

  it('a range shrinks when its end is deleted, and a deleted cell leaves #REF!', () => {
    const { first, get, typed } = budget();
    first().remove('row', 2, 1);
    expect(typed('B3')).toBe('=SUM(B1:B2)');
    expect(get('B3')).toBe(1200);
    first().remove('row', 1, 1);
    expect(typed('B2')).toBe('=SUM(B1:B1)');
    expect(get('B2')).toBe(900);
    expect(typed('D1')).toBe('=#REF!*2');
    expect(get('D1')).toBe('#REF!');
    first().remove('row', 0, 1);
    expect(get('B1')).toBe('#REF!');
  });

  it('rows shuffled inside a summed range are all still summed', () => {
    const { book, first, get, typed } = budget();
    moveKeepingRanges(book, first(), 'row', 0, 1, 3);
    expect(get('A1')).toBe('Food');
    expect(get('A3')).toBe('Rent');
    expect(typed('B4')).toBe('=SUM(B1:B3)');
    expect(get('B4')).toBe(1300);
    expect(typed('D3')).toBe('=B1*2');
    moveKeepingRanges(book, first(), 'row', 2, 1, 0);
    expect(get('A1')).toBe('Rent');
    expect(typed('B4')).toBe('=SUM(B1:B3)');
    moveKeepingRanges(book, first(), 'row', 1, 1, 3);
    expect(get('A3')).toBe('Food');
    expect(get('B4')).toBe(1300);
  });

  it('a row moved out of a summed range is no longer summed, and one moved in is', () => {
    const { book, first, put, get, typed } = budget();
    put('A6', 'Extra');
    put('B6', '7');
    moveKeepingRanges(book, first(), 'row', 0, 1, 5);
    expect(get('A5')).toBe('Rent');
    expect(typed('B3')).toBe('=SUM(B1:B2)');
    expect(get('B3')).toBe(400);
    moveKeepingRanges(book, first(), 'row', 5, 1, 1);
    expect(get('A2')).toBe('Extra');
    expect(typed('B4')).toBe('=SUM(B1:B3)');
    expect(get('B4')).toBe(407);
  });

  it('a range moves along with the rows that hold all of it', () => {
    const { book, first, get, typed } = budget();
    moveKeepingRanges(book, first(), 'row', 0, 4, 10);
    expect(typed('B10')).toBe('=SUM(B7:B9)');
    expect(get('B10')).toBe(1300);
  });

  it('undo brings back a deleted row with its cells', () => {
    const { doc, first, get } = budget();
    const undo = new Y.UndoManager(doc, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    first().remove('row', 1, 1);
    expect(get('B3')).toBe(1000);
    undo.undo();
    expect(get('A2')).toBe('Food');
    expect(get('B4')).toBe(1300);
    expect(get('D1')).toBe(600);
    undo.redo();
    expect(get('B3')).toBe(1000);
  });

  it('never deletes the last row', () => {
    const { first } = open();
    first().remove('row', 0, 5000);
    expect(first().rows.length).toBe(1);
  });
});

describe('two devices editing at once', () => {
  function pair() {
    const a = open();
    a.put('A1', '1');
    a.put('A2', '2');
    a.put('A3', '3');
    a.put('A4', '=SUM(A1:A3)');
    const b = open(new Y.Doc());
    sync(a.doc, b.doc);
    return { a, b };
  }

  it('edits to different cells both survive', () => {
    const { a, b } = pair();
    a.put('A1', '10');
    b.put('A2', '20');
    b.put('B1', 'note');
    sync(a.doc, b.doc);
    for (const side of [a, b]) {
      expect(side.get('A4')).toBe(33);
      expect(side.get('B1')).toBe('note');
    }
  });

  it('an inserted row and an edit below it end up in the right places', () => {
    const { a, b } = pair();
    a.first().insert('row', 0, 1);
    a.put('A1', '100');
    b.put('A3', '30');
    b.put('C3', '=A3+A4');
    sync(a.doc, b.doc);
    for (const side of [a, b]) {
      expect(side.get('A1')).toBe(100);
      expect(side.get('A4')).toBe(30);
      expect(side.typed('A5')).toBe('=SUM(A2:A4)');
      expect(side.get('A5')).toBe(33);
      expect(side.typed('C4')).toBe('=A4+A5');
      expect(side.get('C4')).toBe(63);
    }
  });

  it('a row deleted on one device while edited on the other stays deleted', () => {
    const { a, b } = pair();
    a.first().remove('row', 1, 1);
    b.put('B2', 'late edit');
    sync(a.doc, b.doc);
    for (const side of [a, b]) {
      expect(side.get('A2')).toBe(3);
      expect(side.get('A3')).toBe(4);
      expect(side.first().rows.length).toBe(DEFAULT_ROWS - 1);
    }
  });

  it('the same row moved by both ends up in one place on both', () => {
    const { a, b } = pair();
    moveKeepingRanges(a.book, a.first(), 'row', 0, 1, 3);
    moveKeepingRanges(b.book, b.first(), 'row', 0, 1, 2);
    sync(a.doc, b.doc);
    const column = (side: typeof a) => [1, 2, 3].map(row => side.get(`A${row}`));
    expect(column(a)).toEqual(column(b));
    expect([...column(a)].sort()).toEqual([1, 2, 3]);
    expect(a.get('A4')).toBe(b.get('A4'));
    expect(a.first().rows.length).toBe(DEFAULT_ROWS);
    // Moving it again leaves no second copy behind.
    moveKeepingRanges(a.book, a.first(), 'row', a.first().rows.indexOf('0'), 1, 0);
    sync(a.doc, b.doc);
    expect(column(b)[0]).toBe(1);
    expect(b.first().rows.length).toBe(DEFAULT_ROWS);
  });

  it('the last row of a summed range moved by both devices at once is summed where it ends up', () => {
    for (const [first, second] of [[1, 2], [2, 1]]) {
      const docA = new Y.Doc();
      docA.clientID = first;
      const a = open(docA);
      a.put('A1', '1');
      a.put('A2', '2');
      a.put('A3', '3');
      a.put('A4', '=SUM(A1:A3)');
      const docB = new Y.Doc();
      docB.clientID = second;
      const b = open(docB);
      sync(a.doc, b.doc);
      // One moves the 3 to the top, inside the range; the other moves it below the total.
      moveKeepingRanges(a.book, a.first(), 'row', 2, 1, 0);
      expect(a.get('A4')).toBe(6);
      moveKeepingRanges(b.book, b.first(), 'row', 2, 1, 4);
      expect(b.get('A3')).toBe(3);
      sync(a.doc, b.doc);
      const column = (side: typeof a) => [1, 2, 3, 4].map(row => side.get(`A${row}`));
      expect(column(a)).toEqual(column(b));
      // Either the 3 sits on top and is summed, or it sits under the total and is not.
      expect([[3, 1, 2, 6], [1, 2, 3, 3]]).toContainEqual(column(a));
    }
  });

  it('merged cells added on two devices at once that overlap leave one merge on both', () => {
    const { a, b } = pair();
    a.first().merge({ r1: 0, c1: 1, r2: 1, c2: 2 });
    b.first().merge({ r1: 1, c1: 2, r2: 2, c2: 3 });
    sync(a.doc, b.doc);
    const strip = (list: Array<{ r1: number; c1: number; r2: number; c2: number }>) => list.map(({ r1, c1, r2, c2 }) => ({ r1, c1, r2, c2 }));
    expect(strip(a.first().merges())).toEqual([{ r1: 0, c1: 1, r2: 1, c2: 2 }]);
    expect(strip(b.first().merges())).toEqual(strip(a.first().merges()));
  });

  it('sheets added on both devices are both kept', () => {
    const { a, b } = pair();
    const fromA = a.book.addSheet('Costs');
    b.book.addSheet('Plans');
    a.put('A1', '=Sheet1!A4*2', a.book.sheet(fromA));
    sync(a.doc, b.doc);
    expect(a.book.sheets.map(sheet => sheet.name)).toEqual(b.book.sheets.map(sheet => sheet.name));
    expect(b.book.sheets).toHaveLength(3);
    expect(b.get('A1', b.book.sheet(fromA))).toBe(12);
  });
});

describe('several sheets', () => {
  it('formulas read other sheets and follow renames and deletions', () => {
    const { book, put, get, typed } = open();
    const costs = book.sheet(book.addSheet('Costs 2026'));
    put('A1', '40', costs);
    put('A2', '2', costs);
    put('A1', "='Costs 2026'!A1+SUM('Costs 2026'!A1:A2)");
    expect(get('A1')).toBe(82);
    put('A1', '50', costs);
    expect(get('A1')).toBe(102);
    expect(book.renameSheet(costs.id, 'Costs')).toBe(true);
    expect(typed('A1')).toBe('=Costs!A1+SUM(Costs!A1:A2)');
    expect(book.renameSheet(costs.id, 'sheet1')).toBe(false);
    book.removeSheet(costs.id);
    expect(get('A1')).toBe('#REF!');
    expect(book.sheets).toHaveLength(1);
    book.removeSheet(book.sheets[0].id);
    expect(book.sheets).toHaveLength(1);
  });

  it('reorders tabs', () => {
    const { book } = open();
    const second = book.addSheet();
    const third = book.addSheet();
    expect(book.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3']);
    book.moveSheet(third, 0);
    expect(book.sheets.map(sheet => sheet.name)).toEqual(['Sheet3', 'Sheet1', 'Sheet2']);
    book.moveSheet(third, 2);
    expect(book.sheets.map(sheet => sheet.id)).toEqual(['1', second, third]);
  });
});

describe('looks', () => {
  it('a cell shows its own style over its row over its column', () => {
    const { first } = open();
    const sheet = first();
    const cell = { r1: 2, c1: 1, r2: 2, c2: 1 };
    sheet.patchStyle({ r1: 0, c1: 1, r2: sheet.rows.length - 1, c2: 1 }, { b: 1, c: '#ff0000' }, 'cols');
    expect(sheet.styleAt(5, 1)).toEqual({ b: 1, c: '#ff0000' });
    expect(sheet.styles.size).toBe(1);
    sheet.patchStyle(cell, { b: null, i: 1 });
    expect(sheet.styleAt(2, 1)).toEqual({ i: 1, c: '#ff0000' });
    sheet.patchStyle({ r1: 2, c1: 0, r2: 2, c2: sheet.cols.length - 1 }, { c: '#0000ff' }, 'rows');
    expect(sheet.styleAt(2, 1).c).toBe('#0000ff');
    expect(sheet.styleAt(2, 0).c).toBe('#0000ff');
    expect(sheet.styleAt(3, 1).c).toBe('#ff0000');
    // The column changes colour again: it wins over the older row colour where they cross.
    sheet.patchStyle({ r1: 0, c1: 1, r2: sheet.rows.length - 1, c2: 1 }, { c: '#00ff00' }, 'cols');
    expect(sheet.styleAt(2, 1).c).toBe('#00ff00');
    expect(sheet.styleAt(2, 0).c).toBe('#0000ff');
    sheet.clearStyle(cell, 'all');
    expect(sheet.styles.size).toBe(0);
  });

  it('clearing the looks of whole rows and columns leaves nothing stored', () => {
    const { first } = open();
    const sheet = first();
    const rows = { r1: 1, c1: 0, r2: 2, c2: sheet.cols.length - 1 };
    const cols = { r1: 0, c1: 3, r2: sheet.rows.length - 1, c2: 4 };
    sheet.patchStyle(rows, { i: 1, bg: '#ffec99' }, 'rows');
    sheet.patchStyle(cols, { b: 1 }, 'cols');
    expect(sheet.styleAt(2, 3)).toEqual({ b: 1, i: 1, bg: '#ffec99' });
    sheet.clearStyle(rows, 'rows');
    // The rows are plain again, also where a bold column crosses them.
    expect(sheet.styleAt(2, 9)).toEqual({});
    expect(sheet.styleAt(2, 3)).toEqual({});
    expect(sheet.styleAt(5, 3)).toEqual({ b: 1 });
    sheet.clearStyle(cols, 'cols');
    sheet.clearStyle(rows, 'rows');
    expect(sheet.styles.size).toBe(0);
  });

  it('setting a style back to plain leaves nothing stored', () => {
    const { first } = open();
    const sheet = first();
    const rect = { r1: 0, c1: 0, r2: 1, c2: 1 };
    sheet.patchStyle(rect, { b: 1 });
    expect(sheet.styles.size).toBe(4);
    sheet.patchStyle(rect, { b: null });
    expect(sheet.styles.size).toBe(0);
  });
});
