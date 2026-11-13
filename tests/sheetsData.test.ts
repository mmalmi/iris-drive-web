import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { clearContents, copySelection } from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import {
  findNext,
  findPosition,
  hiddenNear,
  hideSelected,
  replaceAll,
  replaceOne,
  setColumnFilter,
  showHidden,
  sortFiltered,
  sortSelection,
  sortTarget,
  toggleFilter,
} from '../src/lib/sheets/dataCommands';
import { columnChoices } from '../src/lib/sheets/filter';
import { isError } from '../src/lib/sheets/values';

const PEOPLE = [
  ['Name', 'Team', 'Age', 'Pay', 'Bonus'],
  ['Cleo', 'Sales', '41', '$5,200', '=D2*0.1'],
  ['adam', 'Ops', '29', '$4,100', '=D3*0.1'],
  ['Bea', 'Sales', '35', '$6,000', '=D4*0.1'],
  ['Dev', '', '52', '$3,900', '=D5*0.1'],
];

function open(rows: string[][] = PEOPLE, canEdit = true) {
  const ctl = new SheetController(new Y.Doc());
  ctl.start(true);
  const select = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad name ${name}`);
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  rows.forEach((row, r) => row.forEach((text, c) => {
    ctl.setSelection({ row: r, col: c });
    if (text !== '') {
      ctl.startEdit({ text });
      ctl.commitEdit();
    }
  }));
  ctl.canEdit = canEdit;
  const column = (letter: string, from = 1, to = rows.length) => {
    const col = letter.charCodeAt(0) - 65;
    const out: unknown[] = [];
    for (let row = from - 1; row < to; row += 1) {
      const value = ctl.engine.valueAt(ctl.sheet, row, col);
      out.push(isError(value) ? value.code : value);
    }
    return out;
  };
  const visible = () => {
    const hidden = ctl.visibility.rows;
    const out: unknown[] = [];
    for (let row = 0; row < rows.length; row += 1) if (!hidden.has(row)) out.push(ctl.engine.valueAt(ctl.sheet, row, 0));
    return out;
  };
  return { ctl, select, column, visible };
}

describe('sorting', () => {
  it('sorts the table around the active cell and keeps its headings on top', () => {
    const { ctl, select, column } = open();
    select('C3');
    expect(sortTarget(ctl)).toEqual({ rect: { r1: 0, c1: 0, r2: 4, c2: 4 }, header: true, keyCol: 2 });
    sortSelection(ctl, true);
    expect(column('A')).toEqual(['Name', 'adam', 'Bea', 'Cleo', 'Dev']);
    expect(column('C')).toEqual(['Age', 29, 35, 41, 52]);
    // Formulas moved with their rows and still read their own row.
    expect(column('E')).toEqual(['Bonus', 410, 600, 520, 390]);
    select('E2');
    expect(ctl.barText).toBe('=D2*0.1');
    select('A2');
    sortSelection(ctl, false);
    expect(column('A')).toEqual(['Name', 'Dev', 'Cleo', 'Bea', 'adam']);
    ctl.undo();
    expect(column('A')).toEqual(['Name', 'adam', 'Bea', 'Cleo', 'Dev']);
  });

  it('puts empty cells last either way and numbers before text', () => {
    const { ctl, select, column } = open();
    select('B2');
    sortSelection(ctl, true);
    expect(column('B')).toEqual(['Team', 'Ops', 'Sales', 'Sales', null]);
    expect(column('A')).toEqual(['Name', 'adam', 'Cleo', 'Bea', 'Dev']);
    sortSelection(ctl, false);
    expect(column('B')).toEqual(['Team', 'Sales', 'Sales', 'Ops', null]);
    const mixed = open([['b'], ['10'], ['a'], ['9'], ['B2'], ['B10']]);
    mixed.select('A1');
    sortSelection(mixed.ctl, true);
    expect(mixed.column('A', 1, 6)).toEqual([9, 10, 'a', 'b', 'B2', 'B10']);
  });

  it('sorts only the selected range when one is selected, headings or not as told', () => {
    const { ctl, select, column } = open();
    select('C2:D4');
    expect(sortTarget(ctl)?.header).toBe(false);
    sortSelection(ctl, true);
    expect(column('C')).toEqual(['Age', 29, 35, 41, 52]);
    expect(column('A')).toEqual(['Name', 'Cleo', 'adam', 'Bea', 'Dev']);
    expect(ctl.selectionName).toBe('C2:D4');
    select('A1:A5');
    sortSelection(ctl, true, false);
    expect(column('A')).toEqual(['adam', 'Bea', 'Cleo', 'Dev', 'Name']);
  });

  it('lets someone who may only read sort their own copy, and remembers that it is theirs', () => {
    const { ctl, select, column } = open(PEOPLE, false);
    select('A2');
    sortSelection(ctl, true);
    expect(column('A')).toEqual(['Name', 'adam', 'Bea', 'Cleo', 'Dev']);
    expect(ctl.localOnly).toBe(true);
    clearContents(ctl);
    expect(column('A')).toEqual(['Name', 'adam', 'Bea', 'Cleo', 'Dev']);
  });
});

describe('filtering', () => {
  it('leaves rows out by value and by condition, and counts what each column could show', () => {
    const { ctl, select, visible } = open();
    select('A1');
    toggleFilter(ctl);
    const sheet = ctl.sheet;
    const [team, age] = [sheet.cols.ids[1], sheet.cols.ids[2]];
    expect(columnChoices(sheet, ctl.engine, ctl.filter!, team)).toEqual([
      { text: 'Ops', count: 1 }, { text: 'Sales', count: 2 }, { text: '', count: 1 },
    ]);
    setColumnFilter(ctl, team, { excluded: new Set(['Ops', '']), condition: null });
    expect(visible()).toEqual(['Name', 'Cleo', 'Bea']);
    setColumnFilter(ctl, age, { excluded: new Set(), condition: { kind: 'greater', value: '40' } });
    expect(visible()).toEqual(['Name', 'Cleo']);
    // The choices of one column follow what the other columns let through.
    expect(columnChoices(sheet, ctl.engine, ctl.filter!, team).map(choice => choice.text)).toEqual(['Sales', '']);
    setColumnFilter(ctl, team, null);
    expect(visible()).toEqual(['Name', 'Cleo', 'Dev']);
    toggleFilter(ctl);
    expect(visible()).toHaveLength(5);
    // Nothing of this was stored.
    expect([...sheet.props.keys()]).toEqual([]);
  });

  it('follows edits, skips hidden rows when moving, copying and clearing', () => {
    const { ctl, select, visible, column } = open();
    select('A1');
    toggleFilter(ctl);
    setColumnFilter(ctl, ctl.sheet.cols.ids[1], { excluded: new Set(), condition: { kind: 'equals', value: 'sales' } });
    expect(visible()).toEqual(['Name', 'Cleo', 'Bea']);
    select('A2');
    ctl.move(1, 0);
    expect(ctl.selectionName).toBe('A4');
    ctl.move(-1, 0);
    expect(ctl.selectionName).toBe('A2');
    select('A1:B5');
    expect(copySelection(ctl)).toBe('Name\tTeam\nCleo\tSales\nBea\tSales');
    select('C2:C5');
    clearContents(ctl);
    expect(column('C')).toEqual(['Age', null, 29, null, 52]);
    // A row that stops matching drops out of view.
    select('B4');
    ctl.startEdit({ text: 'Ops' });
    ctl.commitEdit();
    expect(visible()).toEqual(['Name', 'Cleo']);
  });

  it('sorts under the headings from a column of the filter', () => {
    const { ctl, select, column } = open();
    select('A1');
    toggleFilter(ctl);
    sortFiltered(ctl, ctl.sheet.cols.ids[3], false);
    expect(column('D')).toEqual(['Pay', 6000, 5200, 4100, 3900]);
    expect(column('A')).toEqual(['Name', 'Bea', 'Cleo', 'adam', 'Dev']);
  });
});

describe('hiding', () => {
  it('hides rows and columns for everyone and shows them again', () => {
    const { ctl, select } = open();
    ctl.selectRows(1, 2);
    hideSelected(ctl, 'row');
    expect([...ctl.visibility.rows]).toEqual([1, 2]);
    expect(ctl.selectionName).toBe('A4');
    ctl.move(-1, 0);
    expect(ctl.selectionName).toBe('A1');
    ctl.move(1, 0);
    expect(ctl.selectionName).toBe('A4');
    expect(hiddenNear(ctl, 'row')).toEqual([1, 3]);
    showHidden(ctl, 'row');
    expect(ctl.visibility.rows.size).toBe(0);
    ctl.selectCols(1, 1);
    hideSelected(ctl, 'col');
    select('A1');
    ctl.move(0, 1);
    expect(ctl.selectionName).toBe('C1');
    ctl.undo();
    expect(ctl.visibility.cols.size).toBe(0);
  });
});

describe('finding and replacing', () => {
  it('goes through the matches in reading order and wraps around', () => {
    const { ctl, select } = open();
    select('A1');
    ctl.find = { query: 'sales', replace: null };
    expect(ctl.findMatches).toEqual([{ row: 1, col: 1 }, { row: 3, col: 1 }]);
    findNext(ctl);
    expect(ctl.selectionName).toBe('B2');
    expect(findPosition(ctl)).toBe(1);
    findNext(ctl);
    expect(ctl.selectionName).toBe('B4');
    findNext(ctl);
    expect(ctl.selectionName).toBe('B2');
    findNext(ctl, true);
    expect(ctl.selectionName).toBe('B4');
    // What cells show is searched, and formulas as written.
    ctl.find = { query: '5,200', replace: null };
    expect(ctl.findMatches).toEqual([{ row: 1, col: 3 }]);
    ctl.find = { query: '*0.1', replace: null };
    expect(ctl.findMatches).toHaveLength(4);
    ctl.find = { query: 'zebra', replace: null };
    expect(ctl.findMatches).toEqual([]);
  });

  it('replaces one at a time or all at once, in text and in formulas', () => {
    const { ctl, select, column } = open();
    select('A1');
    ctl.find = { query: 'sales', replace: 'Retail' };
    findNext(ctl);
    replaceOne(ctl);
    expect(column('B')).toEqual(['Team', 'Retail', 'Ops', 'Sales', null]);
    expect(ctl.selectionName).toBe('B4');
    ctl.find = { query: '0.1', replace: '0.2' };
    replaceAll(ctl);
    expect(column('E')).toEqual(['Bonus', 1040, 820, 1200, 780]);
    expect(ctl.notice).toBe('Replaced in 4 cells.');
    ctl.undo();
    expect(column('E')).toEqual(['Bonus', 520, 410, 600, 390]);
  });
});
