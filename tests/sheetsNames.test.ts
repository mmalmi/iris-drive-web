import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { defineName, listNames, nameProblem, nameText, removeName } from '../src/lib/sheets/names';
import { importXlsx, writeXlsx } from '../src/lib/sheets/xlsx';
import { isError } from '../src/lib/sheets/values';
import { freezeItems } from '../src/components/Sheets/menus';

function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  ctl.book.setLocale('en-US');
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

describe('named ranges', () => {
  it('stand for cells in formulas, follow them, and update when redefined', () => {
    const { ctl, select, type, get } = open();
    ['10', '20', '30'].forEach((text, index) => type(`B${index + 2}`, text));
    type('D1', '=SUM(Sales)*2');
    expect(get('D1')).toBe('#NAME?');
    select('B2:B4');
    expect(ctl.nameSelection('Sales')).toBe('');
    expect(get('D1')).toBe(120);
    type('B3', '25');
    expect(get('D1')).toBe(130);
    // Rows added inside the range belong to it.
    ctl.sheet.insert('row', 3, 1);
    type('B4', '5');
    expect(get('D1')).toBe(140);
    expect(nameText(ctl.book, listNames(ctl.book)[0])).toBe('Sheet1!B2:B5');
    select('B2');
    ctl.nameSelection('sales');
    expect(get('D1')).toBe(20);
    removeName(ctl.book, 'Sales');
    expect(get('D1')).toBe('#NAME?');
  });

  it('jump from the box, also to another sheet, and refuse words that read as cells', () => {
    const { ctl, select } = open();
    const second = ctl.book.addSheet('Costs');
    defineName(ctl.book, 'Rent', ctl.book.sheet(second), { r1: 4, c1: 2, r2: 4, c2: 2 });
    select('A1');
    expect(ctl.goToName('rent')).toBe(true);
    expect(ctl.sheetId).toBe(second);
    expect(ctl.selectionName).toBe('C5');
    expect(nameProblem('B7')).not.toBe('');
    expect(nameProblem('TRUE')).not.toBe('');
    expect(nameProblem('Tax_rate.2026')).toBe('');
  });

  it('defined on another device, a name brings a waiting formula to life there', () => {
    const one = open();
    const two = open(new Y.Doc());
    sync(one.doc, two.doc);
    two.type('A1', '7');
    two.type('C1', '=Rate*2');
    sync(one.doc, two.doc);
    one.select('A1');
    one.ctl.nameSelection('Rate');
    sync(one.doc, two.doc);
    expect(two.get('C1')).toBe(14);
  });

  it('go out to Excel and come back', () => {
    const { ctl, select, type } = open();
    type('A1', '5');
    type('A2', '6');
    select('A1:A2');
    ctl.nameSelection('Pair');
    type('B1', '=SUM(Pair)');
    const data = writeXlsx(ctl.book, ctl.engine);
    const other = open();
    importXlsx(other.ctl, 'Copy.xlsx', data);
    expect(listNames(other.ctl.book).map(named => named.name)).toEqual(['Pair']);
    expect(other.get('B1')).toBe(11);
  });
});

describe('freezing', () => {
  it('freezes up to the active row and column', () => {
    const { ctl, select } = open();
    select('C4');
    const items = freezeItems(ctl);
    expect(items.map(item => item.label)).toEqual(['Freeze up to row 4', 'Freeze up to column C']);
    items[0].action();
    items[1].action();
    expect([ctl.sheet.freezeRows, ctl.sheet.freezeCols]).toEqual([4, 3]);
    expect(freezeItems(ctl).map(item => item.label)).toContain('Unfreeze');
    ctl.selectRows(1, 6);
    expect(freezeItems(ctl, 'row').map(item => item.label)).toEqual(['Freeze up to row 7', 'Unfreeze']);
  });
});
