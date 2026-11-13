import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { cellExtras } from '../src/lib/sheets/extras';
import { addValidation, chooseFromList, toggleCheckboxes } from '../src/lib/sheets/ruleCommands';
import { RuleLooks, addRule, listRules, matches, rangeIds, readRuleValue, removeRule } from '../src/lib/sheets/rules';

function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  ctl.book.setLocale('en-US');
  const rect = (name: string) => {
    const found = parseRectName(name);
    if (!found) throw new Error(`Bad name ${name}`);
    return found;
  };
  const select = (name: string) => {
    const at = rect(name);
    ctl.setSelection({ row: at.r1, col: at.c1 }, { row: at.r2, col: at.c2 });
  };
  const type = (name: string, text: string) => {
    select(name);
    ctl.startEdit({ text });
    ctl.commitEdit();
  };
  const value = (name: string) => {
    const at = rect(name);
    return ctl.engine.valueAt(ctl.sheet, at.r1, at.c1);
  };
  const look = (name: string) => {
    const at = rect(name);
    return new RuleLooks(ctl.sheet, ctl.engine).look(at.r1, at.c1);
  };
  return { ctl, doc, rect, select, type, value, look };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'stored');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'stored');
}

describe('conditions', () => {
  it('compare numbers, dates and text the way people mean', () => {
    expect(matches({ kind: 'gt', a: 100 }, 150, '150')).toBe(true);
    expect(matches({ kind: 'gt', a: 100 }, 'abc', 'abc')).toBe(false);
    expect(matches({ kind: 'between', a: 10, b: 1 }, 5, '5')).toBe(true);
    expect(matches({ kind: 'between', a: 1, b: 10 }, 11, '11')).toBe(false);
    expect(matches({ kind: 'outside', a: 1, b: 10 }, 11, '11')).toBe(true);
    expect(matches({ kind: 'eq', a: 'done' }, 'Done', 'Done')).toBe(true);
    expect(matches({ kind: 'neq', a: 'done' }, 'Open', 'Open')).toBe(true);
    expect(matches({ kind: 'contains', a: 'late' }, 'Very LATE', 'Very LATE')).toBe(true);
    expect(matches({ kind: 'empty' }, null, '')).toBe(true);
    expect(matches({ kind: 'notEmpty' }, 0, '0')).toBe(true);
    expect(readRuleValue('1,000.5', { decimal: '.', thousands: ',' } as never)).toBe(1000.5);
  });
});

describe('conditional formats', () => {
  it('colour cells whose value meets the condition, and follow changes and moved rows', () => {
    const { ctl, type, look, rect } = open();
    ['120', '80', '150'].forEach((text, index) => type(`B${index + 2}`, text));
    const sheet = ctl.sheet;
    addRule(sheet, { type: 'format', range: rangeIds(sheet, rect('B2:B4')), when: { kind: 'gt', a: 100 }, style: { bg: '#b7e1cd', b: 1 } });
    expect(look('B2')).toMatchObject({ bg: '#b7e1cd', b: 1 });
    expect(look('B3').bg).toBeUndefined();
    type('B3', '101');
    expect(look('B3').bg).toBe('#b7e1cd');
    // A row added in the middle is inside the range.
    sheet.insert('row', 2, 1);
    type('B3', '500');
    expect(look('B3').bg).toBe('#b7e1cd');
    expect(look('B5').bg).toBe('#b7e1cd');
  });

  it('the first rule that applies wins, and a colour scale runs from the lowest number to the highest', () => {
    const { ctl, type, look, rect } = open();
    ['0', '50', '100'].forEach((text, index) => type(`A${index + 1}`, text));
    const sheet = ctl.sheet;
    addRule(sheet, { type: 'format', range: rangeIds(sheet, rect('A1:A3')), when: { kind: 'eq', a: 100 }, style: { c: '#a50e0e' } });
    addRule(sheet, { type: 'scale', range: rangeIds(sheet, rect('A1:A3')), colors: ['#ffffff', null, '#000000'] });
    expect(look('A1').bg).toBe('#ffffff');
    expect(look('A2').bg).toBe('#808080');
    expect(look('A3')).toEqual({ c: '#a50e0e' });
    addRule(sheet, { type: 'scale', range: rangeIds(sheet, rect('C1:C3')), colors: ['#ff0000', '#ffff00', '#00ff00'] });
    ['1', '2', '3'].forEach((text, index) => type(`C${index + 1}`, text));
    expect([look('C1').bg, look('C2').bg, look('C3').bg]).toEqual(['#ff0000', '#ffff00', '#00ff00']);
  });

  it('rules added on two devices at once are both kept, and undo takes back only this one\'s', () => {
    const one = open();
    const two = open(new Y.Doc());
    sync(one.doc, two.doc);
    addRule(one.ctl.sheet, { type: 'format', range: rangeIds(one.ctl.sheet, one.rect('A1:A9')), when: { kind: 'notEmpty' }, style: { bg: '#fce8b2' } });
    addValidation(two.ctl, { kind: 'checkbox' }, true);
    sync(one.doc, two.doc);
    expect(listRules(one.ctl.sheet).map(placed => placed.rule.type).sort()).toEqual(['format', 'valid']);
    one.ctl.undo();
    sync(one.doc, two.doc);
    expect(listRules(two.ctl.sheet).map(placed => placed.rule.type)).toEqual(['valid']);
  });
});

describe('checkboxes and lists', () => {
  it('checkboxes start unticked, tick on toggle, all at once in a selection, and count with COUNTIF', () => {
    const { ctl, select, value, type } = open();
    select('A1:A3');
    addValidation(ctl, { kind: 'checkbox' }, true);
    expect(value('A1')).toBe(false);
    select('A2');
    expect(toggleCheckboxes(ctl)).toBe(true);
    expect(value('A2')).toBe(true);
    select('A1:A3');
    toggleCheckboxes(ctl);
    expect([value('A1'), value('A2'), value('A3')]).toEqual([true, true, true]);
    type('B1', '=COUNTIF(A1:A3, TRUE)');
    expect(value('B1')).toBe(3);
    // Text is refused in a checkbox.
    select('A1');
    ctl.startEdit({ text: 'maybe' });
    ctl.commitEdit();
    expect(ctl.edit?.text).toBe('maybe');
    expect(ctl.notice).toContain('checkbox');
    ctl.cancelEdit();
    expect(cellExtras(ctl.sheet, ctl.engine)?.control(0, 0)).toBe('checkbox');
  });

  it('a list refuses what is not on it, or only marks it when asked to', () => {
    const { ctl, select, type, value } = open();
    select('B2:B5');
    const id = addValidation(ctl, { kind: 'list', items: ['Open', 'Doing', 'Done'] }, true) as string;
    chooseFromList(ctl, 1, 1, 'Doing');
    expect(value('B2')).toBe('Doing');
    type('B3', 'done');
    expect(value('B3')).toBe('done');
    select('B4');
    ctl.startEdit({ text: 'Later' });
    ctl.commitEdit();
    expect(ctl.notice).toBe('Choose one of: Open, Doing, Done.');
    ctl.cancelEdit();
    expect(value('B4')).toBeNull();
    const placed = listRules(ctl.sheet).find(rule => rule.id === id);
    if (placed?.rule.type !== 'valid') throw new Error('no rule');
    removeRule(ctl.sheet, id);
    addRule(ctl.sheet, { ...placed.rule, reject: false });
    type('B4', 'Later');
    expect(value('B4')).toBe('Later');
    const extras = cellExtras(ctl.sheet, ctl.engine);
    expect(extras?.invalid(3, 1)).toBe(true);
    expect(extras?.invalid(1, 1)).toBe(false);
    expect(extras?.control(3, 1)).toBe('list');
  });

  it('numbers and dates in a range', () => {
    const { ctl, select } = open();
    select('C1');
    addValidation(ctl, { kind: 'number', min: 1, max: 10 }, true);
    ctl.startEdit({ text: '11' });
    ctl.commitEdit();
    expect(ctl.notice).toBe('Enter a number from 1 to 10.');
    ctl.setEditText('7', [1, 1]);
    ctl.commitEdit();
    expect(ctl.edit).toBeNull();
    select('D1');
    addValidation(ctl, { kind: 'date', min: 46023 }, true);
    ctl.startEdit({ text: '12/31/2025' });
    ctl.commitEdit();
    expect(ctl.notice).toMatch(/^Enter a date of at least /);
  });
});
