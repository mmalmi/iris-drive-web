import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { applyBorders, insertBeside } from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { dateNames, formatValue, localeFor } from '../src/lib/sheets/format';
import { moveKeepingRanges, reconcileMoves } from '../src/lib/sheets/structure';
import { isError } from '../src/lib/sheets/values';

function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  const select = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(name);
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  const type = (name: string, text: string) => {
    select(name);
    ctl.startEdit({ text });
    ctl.commitEdit();
  };
  const get = (name: string) => {
    const rect = parseRectName(name) as { r1: number; c1: number };
    const value = ctl.engine.valueAt(ctl.sheet, rect.r1, rect.c1);
    return isError(value) ? value.code : value;
  };
  return { ctl, doc, select, type, get };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'stored');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'stored');
}

describe('two devices moving different rows of one range at once', () => {
  it('keep both moves in the formula', () => {
    const one = open();
    const two = open(new Y.Doc());
    for (let row = 2; row <= 10; row += 1) one.type(`B${row}`, String(row * 10));
    one.type('D1', '=SUM(B2:B10)');
    sync(one.doc, two.doc);
    expect(two.get('D1')).toBe(540);
    // One moves the first row of the range down inside it; the other the last row up inside it.
    moveKeepingRanges(one.ctl.book, one.ctl.sheet, 'row', 1, 1, 6);
    moveKeepingRanges(two.ctl.book, two.ctl.sheet, 'row', 9, 1, 4);
    expect(one.get('D1')).toBe(540);
    expect(two.get('D1')).toBe(540);
    sync(one.doc, two.doc);
    reconcileMoves(one.ctl.book);
    reconcileMoves(two.ctl.book);
    sync(one.doc, two.doc);
    expect(one.get('D1')).toBe(540);
    expect(two.get('D1')).toBe(540);
    expect(one.ctl.sheet.cells.get(one.ctl.sheet.rows.ids[0] + ':' + one.ctl.sheet.cols.ids[3])).toBe(two.ctl.sheet.cells.get(two.ctl.sheet.rows.ids[0] + ':' + two.ctl.sheet.cols.ids[3]));
    // Nothing more to do once both are in.
    expect(reconcileMoves(one.ctl.book)).toBe(0);
  });

  it('a move that takes a row out of the range on one device and one inside it on the other', () => {
    const one = open();
    const two = open(new Y.Doc());
    for (let row = 2; row <= 6; row += 1) one.type(`B${row}`, String(row));
    one.type('D1', '=SUM(B2:B6)');
    sync(one.doc, two.doc);
    // Row 6 (the last) moved out, below the range; row 2 (the first) moved inside it.
    moveKeepingRanges(one.ctl.book, one.ctl.sheet, 'row', 5, 1, 9);
    moveKeepingRanges(two.ctl.book, two.ctl.sheet, 'row', 1, 1, 4);
    sync(one.doc, two.doc);
    reconcileMoves(one.ctl.book);
    reconcileMoves(two.ctl.book);
    sync(one.doc, two.doc);
    // 2 + 3 + 4 + 5; 6 was taken out.
    expect(one.get('D1')).toBe(14);
    expect(two.get('D1')).toBe(14);
  });
});

describe('inserting below a bordered table', () => {
  it('moves its closing line down instead of drawing it twice', () => {
    const { ctl, select, type } = open();
    type('A1', 'Item');
    select('A1:C3');
    applyBorders(ctl, 'outer', 's');
    ctl.selectRows(2, 2);
    insertBeside(ctl, 'row', true);
    const sheet = ctl.sheet;
    for (let col = 0; col < 3; col += 1) {
      expect(sheet.borderAt(2, col, 'bb')).toBeUndefined();
      expect(sheet.borderAt(3, col, 'bb')).toBe('s');
    }
    expect(sheet.borderAt(3, 0, 'bl')).toBe('s');
    expect(sheet.borderAt(3, 2, 'br')).toBe('s');
  });

  it('keeps lines between rows of a fully bordered table, and a lone heading line where it is', () => {
    const { ctl, select } = open();
    select('A1:B2');
    applyBorders(ctl, 'all', 's');
    ctl.selectRows(1, 1);
    insertBeside(ctl, 'row', true);
    const sheet = ctl.sheet;
    expect(sheet.borderAt(1, 0, 'bb')).toBe('s');
    expect(sheet.borderAt(2, 0, 'bb')).toBe('s');
    select('E5:F5');
    applyBorders(ctl, 'bottom', 'm');
    ctl.selectRows(4, 4);
    insertBeside(ctl, 'row', true);
    expect(sheet.borderAt(4, 4, 'bb')).toBe('m');
  });
});

describe('month and day names', () => {
  it('follow the spreadsheet\'s language, in cells and in TEXT()', () => {
    expect(dateNames('de-DE').months[2]).toBe('März');
    expect(dateNames('fr-FR').days[1]).toBe('Lundi');
    // 13 March 2026 was a Friday.
    expect(formatValue(46094, 'dddd d mmmm yyyy', localeFor('de-DE'))).toBe('Freitag 13 März 2026');
    expect(formatValue(46094, 'ddd d mmm', localeFor('en-US'))).toBe('Fri 13 Mar');
    const { ctl, type, get } = open();
    ctl.book.setLocale('de-DE');
    type('A1', '=TEXT(DATE(2026;3;13);"dddd, d. mmmm")');
    expect(get('A1')).toBe('Freitag, 13. März');
    type('A2', '=TEXT(1234.5;"#,##0.00")');
    expect(get('A2')).toBe('1.234,50');
  });
});
