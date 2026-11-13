import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import {
  adjustDecimals,
  applyBorders,
  applyStyle,
  clearContents,
  clearFormatting,
  mergeSelection,
  setFontSize,
  unmergeSelection,
  copiedHtml,
  copySelection,
  deleteSelected,
  duplicateSheet,
  exportCsv,
  fillInto,
  fillWithin,
  importCsv,
  insertBeside,
  moveSelected,
  moveSelectedTo,
  pasteText,
  removeSheet,
  toggleStyle,
} from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { isError } from '../src/lib/sheets/values';

function open() {
  const ctl = new SheetController(new Y.Doc());
  ctl.start(true);
  const at = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad name ${name}`);
    return rect;
  };
  const select = (name: string) => {
    const rect = at(name);
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  return {
    ctl,
    select,
    /** Types text into a cell the way a person does: select, type, Enter. */
    type(name: string, text: string) {
      select(name);
      ctl.startEdit({ text });
      ctl.commitEdit('down');
    },
    get(name: string) {
      const rect = at(name);
      const value = ctl.engine.valueAt(ctl.sheet, rect.r1, rect.c1);
      return isError(value) ? value.code : value;
    },
    show(name: string) {
      const rect = at(name);
      return ctl.engine.textAt(ctl.sheet, rect.r1, rect.c1);
    },
    formula(name: string) {
      select(name);
      return ctl.barText;
    },
    style(name: string) {
      const rect = at(name);
      return ctl.sheet.styleAt(rect.r1, rect.c1);
    },
  };
}

describe('typing', () => {
  it('stores what was typed and moves on', () => {
    const { ctl, type, get } = open();
    type('B2', '12');
    expect(get('B2')).toBe(12);
    expect(ctl.selectionName).toBe('B3');
    ctl.startEdit({ text: 'x' });
    ctl.cancelEdit();
    expect(get('B3')).toBe(null);
    expect(ctl.selectionName).toBe('B3');
    expect(ctl.canUndo).toBe(true);
  });

  it('does nothing when the text was not changed, or when the sheet is read-only', () => {
    const { ctl, type, select, get } = open();
    type('A1', 'keep');
    const steps = ctl.undoManager.undoStack.length;
    select('A1');
    ctl.startEdit();
    ctl.commitEdit();
    expect(ctl.undoManager.undoStack.length).toBe(steps);
    ctl.canEdit = false;
    expect(ctl.startEdit({ text: 'no' })).toBe(false);
    clearContents(ctl);
    expect(get('A1')).toBe('keep');
  });

  it('a number typed into a percentage stays a percentage', () => {
    const { ctl, type, select, show } = open();
    type('A1', '25%');
    select('A1');
    ctl.startEdit({ text: '4' });
    expect(ctl.edit?.text).toBe('4%');
    ctl.setEditText('40%', [2, 2]);
    ctl.commitEdit();
    expect(show('A1')).toBe('40%');
  });

  it('puts addresses of pointed-at cells into a formula', () => {
    const { ctl, type, select, get } = open();
    type('A1', '2');
    type('A2', '3');
    select('C1');
    ctl.startEdit({ text: '=' });
    expect(ctl.pointing).toBe(true);
    ctl.pointDrag({ row: 0, col: 0 }, { row: 0, col: 0 });
    expect(ctl.edit?.text).toBe('=A1');
    // Dragging on replaces the address just inserted.
    ctl.pointDrag({ row: 0, col: 0 }, { row: 1, col: 0 });
    expect(ctl.edit?.text).toBe('=A1:A2');
    ctl.setEditText('=A1:A2*', [7, 7]);
    ctl.pointMove(0, -1, false);
    expect(ctl.edit?.text).toBe('=A1:A2*B1');
    ctl.setEditText('=SUM(A1:A2)*2', [13, 13]);
    expect(ctl.pointing).toBe(false);
    ctl.commitEdit();
    expect(get('C1')).toBe(10);
    expect(ctl.selectionName).toBe('C1');
  });

  it('points at cells of another sheet', () => {
    const { ctl, type, get } = open();
    type('A1', '7');
    const second = ctl.book.addSheet();
    ctl.showSheet(second);
    ctl.startEdit({ text: '=2*' });
    ctl.showSheet(ctl.sheets[0].id);
    ctl.pointDrag({ row: 0, col: 0 }, { row: 0, col: 0 });
    expect(ctl.edit?.text).toBe('=2*Sheet1!A1');
    ctl.commitEdit();
    expect(ctl.sheetId).toBe(second);
    expect(get('A1')).toBe(14);
  });

  it('offers functions and writes the chosen one', () => {
    const { ctl, select } = open();
    select('A1');
    ctl.startEdit({ text: '=av' });
    expect(ctl.completion?.matches.map(doc => doc.name)).toEqual(['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS']);
    ctl.moveCompletion(1);
    ctl.acceptCompletion();
    expect(ctl.edit?.text).toBe('=AVERAGEIF(');
    expect(ctl.callHint).toMatchObject({ doc: { name: 'AVERAGEIF' }, argument: 0 });
    ctl.setEditText('=AVERAGEIF(A1:A3,', [17, 17]);
    expect(ctl.callHint?.argument).toBe(1);
    ctl.setEditText('=su', [3, 3]);
    ctl.closeCompletion();
    expect(ctl.completion).toBeNull();
    ctl.setEditText('=sum', [4, 4]);
    expect(ctl.completion).not.toBeNull();
  });

  it('switches an address between moving and fixed', () => {
    const { ctl, select } = open();
    select('C1');
    ctl.startEdit({ text: '=A1+Sheet1!B2:C3' });
    for (const expected of ['=A1+Sheet1!$B$2:$C$3', '=A1+Sheet1!B$2:C$3', '=A1+Sheet1!$B2:$C3', '=A1+Sheet1!B2:C3']) {
      ctl.cycleAbsolute();
      expect(ctl.edit?.text).toBe(expected);
    }
    ctl.setEditText(ctl.edit?.text ?? '', [3, 3]);
    ctl.cycleAbsolute();
    expect(ctl.edit?.text).toBe('=$A$1+Sheet1!B2:C3');
  });

  it('keeps a selected block selected while it is filled in', () => {
    const { ctl, select, get } = open();
    select('A1:B2');
    for (const text of ['1', '2', '3', '4']) {
      ctl.startEdit({ text });
      ctl.commitEdit('right');
    }
    expect([get('A1'), get('B1'), get('A2'), get('B2')]).toEqual([1, 2, 3, 4]);
    expect(ctl.selectionName).toBe('A1:B2');
    expect(ctl.active).toEqual({ row: 0, col: 0 });
  });

  it('after tabbing along a row, Enter goes back under where the row began', () => {
    const { ctl, select } = open();
    select('B5');
    ctl.startEdit({ text: 'a' });
    ctl.commitEdit('right');
    ctl.startEdit({ text: 'b' });
    ctl.commitEdit('right');
    ctl.startEdit({ text: 'c' });
    ctl.commitEdit('down');
    expect(ctl.selectionName).toBe('B6');
  });
});

describe('undo', () => {
  it('goes back one step at a time and takes the selection along', () => {
    const { ctl, type, select, get } = open();
    type('A1', 'one');
    type('C3', 'two');
    select('E5');
    ctl.undo();
    expect(get('C3')).toBe(null);
    expect(ctl.selectionName).toBe('C3');
    ctl.undo();
    expect(get('A1')).toBe(null);
    expect(ctl.selectionName).toBe('A1');
    expect(ctl.canUndo).toBe(false);
    ctl.redo();
    ctl.redo();
    expect(get('C3')).toBe('two');
    expect(ctl.selectionName).toBe('C3');
    expect(ctl.canRedo).toBe(false);
  });

  it('does not undo what came from elsewhere', () => {
    const { ctl, type, get } = open();
    type('A1', 'mine');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ctl.book.doc));
    other.getMap('1:cells').set('1:1', 'theirs');
    Y.applyUpdate(ctl.book.doc, Y.encodeStateAsUpdate(other), 'stored');
    expect(get('B2')).toBe('theirs');
    ctl.undo();
    expect(get('A1')).toBe(null);
    expect(get('B2')).toBe('theirs');
    expect(ctl.canUndo).toBe(false);
  });
});

describe('the clipboard', () => {
  function table() {
    const sheet = open();
    sheet.type('A1', '2');
    sheet.type('B1', '$3.50');
    sheet.type('C1', '=A1*B1');
    sheet.type('A2', '4');
    sheet.type('B2', '$1.25');
    sheet.type('C2', '=A2*$B$1');
    return sheet;
  }

  it('copies what cells show, with their looks for other programs', () => {
    const { ctl, select } = table();
    select('B1');
    toggleStyle(ctl, 'b');
    select('A1:C2');
    expect(copySelection(ctl)).toBe('2\t$3.50\t$7.00\n4\t$1.25\t$14.00');
    const html = copiedHtml(ctl);
    expect(html.replace(/ data-iris-[a-z]+="[^"]*"/g, '')).toBe('<table style="border-collapse:collapse"><tr><td>2</td><td style="font-weight:bold">$3.50</td><td>$7.00</td></tr><tr><td>4</td><td>$1.25</td><td>$14.00</td></tr></table>');
    expect(html).toContain('data-iris-value="3.5"');
  });

  it('pasting our own copy brings formulas along, moved to their new place', () => {
    const { ctl, select, get, formula, show } = table();
    select('A1:C2');
    const text = copySelection(ctl);
    select('A4');
    pasteText(ctl, text);
    expect(ctl.selectionName).toBe('A4:C5');
    expect(formula('C4')).toBe('=A4*B4');
    expect(formula('C5')).toBe('=A5*$B$1');
    expect(get('C4')).toBe(7);
    expect(show('B5')).toBe('$1.25');
    // One undo takes the whole paste back.
    ctl.undo();
    expect(get('A4')).toBe(null);
    expect(get('C5')).toBe(null);
  });

  it('a formula pasted too close to the edge says so instead of pointing at the wrong cell', () => {
    const { ctl, select, formula, get } = table();
    select('C2');
    const text = copySelection(ctl);
    select('A2');
    pasteText(ctl, text);
    expect(formula('A2')).toBe('=#REF!*$B$1');
    expect(get('A2')).toBe('#REF!');
  });

  it('pastes values only when asked', () => {
    const { ctl, select, formula, show } = table();
    select('C1:C2');
    const text = copySelection(ctl);
    select('E1');
    pasteText(ctl, text, true);
    expect(formula('E1')).toBe('7');
    expect(formula('E2')).toBe('14');
    expect(show('E1')).toBe('7');
  });

  it('cutting moves cells and leaves the formula reading the same cells', () => {
    const { ctl, select, get, formula } = table();
    select('C1');
    const text = copySelection(ctl, true);
    select('E5');
    pasteText(ctl, text);
    expect(get('C1')).toBe(null);
    expect(formula('E5')).toBe('=A1*B1');
    expect(ctl.copied).toBeNull();
    // Pasting the same text again is now plain text from the clipboard.
    select('G1');
    pasteText(ctl, text);
    expect(get('G1')).toBe(7);
  });

  it('formulas elsewhere follow cut cells to where they are pasted', () => {
    const { ctl, select, type, get, formula } = table();
    type('E1', '=SUM(A1:A2)');
    type('E2', '=B1*2');
    type('E3', '=SUM(A1:B1)');
    select('A1:B2');
    const text = copySelection(ctl, true);
    select('A11');
    pasteText(ctl, text);
    // Wholly moved ranges and single cells follow; formulas that moved keep reading the moved cells.
    expect(formula('E1')).toBe('=SUM(A11:A12)');
    expect(formula('E2')).toBe('=B11*2');
    expect(formula('E3')).toBe('=SUM(A11:B11)');
    expect(formula('C1')).toBe('=A11*B11');
    expect(get('E1')).toBe(6);
    expect(get('C1')).toBe(7);
    // A range only partly moved stays where it was.
    type('F1', '=SUM(A11:A13)');
    select('A11');
    const one = copySelection(ctl, true);
    select('H1');
    pasteText(ctl, one);
    expect(formula('F1')).toBe('=SUM(A11:A13)');
    expect(formula('E1')).toBe('=SUM(A11:A12)');
    ctl.undo();
    expect(get('A11')).toBe(2);
  });

  it('a cut cell pasted on another sheet is read there by formulas on the first', () => {
    const { ctl, select, type, formula } = table();
    type('E1', '=A1+1');
    select('A1');
    const text = copySelection(ctl, true);
    const first = ctl.sheetId;
    const id = ctl.book.addSheet('Notes');
    ctl.showSheet(id);
    select('B2');
    pasteText(ctl, text);
    ctl.showSheet(first);
    expect(formula('E1')).toBe('=Notes!B2+1');
    expect(formula('C1')).toBe('=Notes!B2*B1');
  });

  it('reads text from other programs as typed values', () => {
    const { ctl, select, get, show } = open();
    select('B2');
    pasteText(ctl, 'Name\tJoined\tShare\r\nAda\t2026-01-05\t12.5%\r\n"Smith, J"\t5.1.2026\t7%\r\n');
    expect(ctl.selectionName).toBe('B2:D4');
    expect(get('B4')).toBe('Smith, J');
    expect(show('C3')).toBe('2026-01-05');
    expect(show('C4')).toBe('5.1.2026');
    expect(get('D3')).toBe(0.125);
    expect(show('D4')).toBe('7%');
  });

  it('fills a larger selection with copies and makes the sheet larger when needed', () => {
    const { ctl, select, get } = open();
    select('A1:B4');
    pasteText(ctl, 'x\ty\n1\t2');
    expect([get('A3'), get('B3'), get('A4'), get('B4')]).toEqual(['x', 'y', 1, 2]);
    select('C1:C3');
    pasteText(ctl, 'one');
    expect(get('C3')).toBe('one');
    const wide = Array.from({ length: 40 }, (_unused, index) => `c${index}`).join('\t');
    select('A10');
    pasteText(ctl, wide);
    expect(ctl.sheet.cols.length).toBe(40);
    expect(ctl.engine.valueAt(ctl.sheet, 9, 39)).toBe('c39');
  });

  it('copies a whole column only as far as it is filled', () => {
    const { ctl, type } = open();
    type('B1', 'a');
    type('B3', 'c');
    ctl.selectCols(1, 1);
    expect(copySelection(ctl)).toBe('a\n\nc');
  });
});

describe('filling', () => {
  it('continues a series downwards and copies looks along', () => {
    const { ctl, type, select, get, style, formula } = open();
    type('A1', '10');
    type('A2', '20');
    type('B1', '=A1+1');
    select('A1:A2');
    applyStyle(ctl, { bg: '#ffec99' });
    fillInto(ctl, { r1: 0, c1: 0, r2: 5, c2: 0 });
    expect(get('A6')).toBe(60);
    expect(style('A6')).toEqual({ bg: '#ffec99' });
    expect(ctl.selectionName).toBe('A1:A6');
    select('B1');
    fillInto(ctl, { r1: 0, c1: 1, r2: 5, c2: 1 });
    expect(formula('B6')).toBe('=A6+1');
    expect(get('B6')).toBe(61);
    select('B1:B6');
    fillInto(ctl, { r1: 0, c1: 1, r2: 5, c2: 3 });
    expect(formula('D6')).toBe('=C6+1');
    expect(get('D6')).toBe(63);
  });

  it('fills a selection from its first row or column', () => {
    const { ctl, type, select, get } = open();
    type('A1', '5');
    type('B1', '=A1*2');
    select('A1:B4');
    fillWithin(ctl, 'down');
    expect(get('A4')).toBe(5);
    expect(get('B4')).toBe(10);
    expect(ctl.selectionName).toBe('A1:B4');
  });
});

describe('rows, columns and sheets', () => {
  function table() {
    const sheet = open();
    sheet.type('A1', 'Rent');
    sheet.type('B1', '$900');
    sheet.type('A2', 'Food');
    sheet.type('B2', '$300');
    sheet.type('A3', 'Total');
    sheet.type('B3', '=SUM(B1:B2)');
    return sheet;
  }

  it('a new row looks like the row it was added next to', () => {
    const { ctl, select, type, show, style, formula } = table();
    select('A2');
    toggleStyle(ctl, 'i');
    ctl.selectRows(1, 1);
    insertBeside(ctl, 'row', false);
    expect(ctl.selectionName).toBe('2:2');
    expect(style('A2')).toEqual({ i: 1 });
    type('B2', '50');
    expect(show('B2')).toBe('$50.00');
    expect(show('B4')).toBe('$1,250.00');
    expect(ctl.sheet.rows.length).toBe(1001);
    // A row added from the last summed one, below it, is summed too: a line added to the list.
    ctl.selectRows(2, 2);
    insertBeside(ctl, 'row', true);
    type('B4', '1');
    expect(show('B4')).toBe('$1.00');
    expect(show('B5')).toBe('$1,251.00');
    expect(formula('B5')).toBe('=SUM(B1:B4)');
    // Added from the total row, above it, it is not.
    ctl.selectRows(4, 4);
    insertBeside(ctl, 'row', false);
    type('B5', '7');
    expect(formula('B6')).toBe('=SUM(B1:B4)');
    // From the first summed row, above it, it is.
    ctl.selectRows(0, 0);
    insertBeside(ctl, 'row', false);
    expect(formula('B7')).toBe('=SUM(B1:B5)');
  });

  it('borders go on and off, and the line between two cells is kept once', () => {
    const { ctl, select, style } = table();
    select('A1:B3');
    applyBorders(ctl, 'all', 's');
    expect(style('A1')).toMatchObject({ bt: 's', bb: 's', bl: 's', br: 's' });
    expect(style('A2').bt).toBeUndefined();
    expect(ctl.sheet.borderAt(1, 0, 'bt')).toBe('s');
    select('A2');
    applyBorders(ctl, 'none', 's');
    expect(ctl.sheet.borderAt(1, 0, 'bt')).toBeUndefined();
    expect(ctl.sheet.borderAt(1, 0, 'br')).toBeUndefined();
    expect(ctl.sheet.borderAt(0, 0, 'bt')).toBe('s');
    select('A1:B3');
    applyBorders(ctl, 'outer', 'k#e03131');
    expect(ctl.sheet.borderAt(2, 1, 'bb')).toBe('k#e03131');
    expect(ctl.sheet.borderAt(0, 1, 'bb')).toBe('s');
    // A row added below one inside the table gets the same lines.
    ctl.selectRows(1, 1);
    insertBeside(ctl, 'row', true);
    expect(ctl.sheet.borderAt(2, 1, 'bt')).toBe('s');
    ctl.undo();
    select('A1:B3');
    clearFormatting(ctl);
    for (const name of ['A1', 'B2', 'B3', 'C1', 'A4']) expect(style(name)).toEqual({});
    ctl.undo();
    expect(ctl.sheet.borderAt(2, 1, 'bb')).toBe('k#e03131');
  });

  it('merged cells act as one cell', () => {
    const { ctl, select, get, show } = table();
    select('A5:C5');
    ctl.startEdit({ text: 'Budget' });
    ctl.commitEdit();
    select('A5:C6');
    ctl.sheet.setRaw(5, 1, 'lost');
    mergeSelection(ctl, 'all');
    expect(ctl.notice).toBe('Only the first cell of each merged block keeps its content.');
    expect(get('B6')).toBe(null);
    expect(show('A5')).toBe('Budget');
    // Clicking any part selects all of it, named after its first cell.
    select('B6');
    expect(ctl.selectionName).toBe('A5');
    expect(ctl.selection).toEqual({ r1: 4, c1: 0, r2: 5, c2: 2 });
    // Arrows step over it whole.
    ctl.move(0, 1);
    expect(ctl.selectionName).toBe('D5');
    ctl.move(0, -1);
    expect(ctl.selectionName).toBe('A5');
    ctl.move(1, 0);
    expect(ctl.selectionName).toBe('A7');
    // A selection that reaches into it takes all of it.
    select('D6');
    ctl.move(0, -1, { extend: true });
    expect(ctl.selection).toEqual({ r1: 4, c1: 0, r2: 5, c2: 3 });
    // A row inserted inside it makes it taller; unmerging gives the cells back.
    ctl.selectRows(5, 5);
    insertBeside(ctl, 'row', false);
    expect(ctl.sheet.merges()[0]).toMatchObject({ r1: 4, r2: 6, c1: 0, c2: 2 });
    select('A5');
    unmergeSelection(ctl);
    expect(ctl.sheet.merges()).toEqual([]);
    select('B6');
    expect(ctl.selectionName).toBe('B6');
    ctl.undo();
    expect(ctl.sheet.merges()).toHaveLength(1);
    // Merging each row on its own.
    select('A10:B11');
    mergeSelection(ctl, 'across');
    expect(ctl.sheet.merges()).toHaveLength(3);
  });

  it('a larger font makes its row taller', () => {
    const { ctl, select, style } = table();
    select('A1');
    setFontSize(ctl, 18);
    expect(style('A1').fs).toBe(18);
    setFontSize(ctl, 10);
    expect(style('A1').fs).toBeUndefined();
  });

  it('inserts as many rows as are selected, and deletes them', () => {
    const { ctl, get } = table();
    ctl.selectRows(0, 1);
    insertBeside(ctl, 'row', false);
    expect(ctl.selectionName).toBe('1:2');
    expect(get('A3')).toBe('Rent');
    deleteSelected(ctl, 'row');
    expect(get('A1')).toBe('Rent');
    expect(ctl.selectionName).toBe('1:1');
    ctl.selectAll();
    deleteSelected(ctl, 'row');
    expect(ctl.notice).toBe('A sheet needs at least one row.');
    expect(get('A1')).toBe('Rent');
  });

  it('moves rows and columns one place or to where they are dropped', () => {
    const { ctl, get, formula } = table();
    ctl.selectRows(0, 0);
    moveSelected(ctl, 'row', true);
    expect([get('A1'), get('A2')]).toEqual(['Food', 'Rent']);
    expect(ctl.selectionName).toBe('2:2');
    expect(formula('B3')).toBe('=SUM(B1:B2)');
    ctl.selectCols(0, 0);
    moveSelectedTo(ctl, 'col', 2);
    expect(ctl.selectionName).toBe('B:B');
    expect(get('B1')).toBe('Food');
    expect(formula('A3')).toBe('=SUM(A1:A2)');
    ctl.undo();
    expect(get('A1')).toBe('Food');
    expect(ctl.selectionName).toBe('A:A');
    // Redoing selects the column where it has gone again.
    ctl.redo();
    expect(get('B1')).toBe('Food');
    expect(ctl.selectionName).toBe('B:B');
  });

  it('undoing a deletion selects the rows that came back', () => {
    const { ctl, get, select } = table();
    ctl.selectRows(0, 1);
    deleteSelected(ctl, 'row');
    expect(get('A1')).toBe('Total');
    select('D9');
    ctl.undo();
    expect(get('A1')).toBe('Rent');
    expect(ctl.selectionName).toBe('1:2');
  });

  it('looks given to cells from the first row to the last are stored once per column', () => {
    const { ctl, style } = table();
    ctl.setSelection({ row: 0, col: 1 }, { row: ctl.sheet.rows.length - 1, col: 2 });
    const before = ctl.sheet.styles.size;
    applyStyle(ctl, { b: 1 });
    expect(ctl.sheet.styles.size).toBeLessThanOrEqual(before + 2);
    expect(style('C500')).toEqual({ b: 1 });
  });

  it('changes decimal places from what the cell shows', () => {
    const { ctl, type, select, show } = open();
    type('A1', '2.5');
    select('A1');
    adjustDecimals(ctl, 1);
    expect(show('A1')).toBe('2.50');
    adjustDecimals(ctl, -2);
    expect(show('A1')).toBe('3');
  });

  it('copies a sheet with its formulas reading the copy', () => {
    const { ctl, type, get, formula } = table();
    duplicateSheet(ctl, ctl.sheetId);
    expect(ctl.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'Sheet1 copy']);
    expect(ctl.sheetId).toBe(ctl.sheets[1].id);
    type('B1', '1000');
    expect(get('B3')).toBe(1300);
    expect(formula('B3')).toBe('=SUM(B1:B2)');
    ctl.showSheet(ctl.sheets[0].id);
    expect(get('B3')).toBe(1200);
    removeSheet(ctl, ctl.sheets[1].id);
    expect(ctl.sheets).toHaveLength(1);
    removeSheet(ctl, ctl.sheets[0].id);
    expect(ctl.sheets).toHaveLength(1);
  });

  it('brings a CSV file in as a new sheet and writes one out', () => {
    const { ctl, get, show } = table();
    importCsv(ctl, 'prices 2026.csv', 'Item;Price;When\nTea;2,50;2026-03-01\n"Milk; oat";1,20;2026-03-02\n');
    expect(ctl.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'prices 2026']);
    expect(get('B2')).toBe(2.5);
    expect(get('A3')).toBe('Milk; oat');
    expect(show('C3')).toBe('2026-03-02');
    expect(exportCsv(ctl)).toBe('Item,Price,When\r\nTea,2.5,2026-03-01\r\nMilk; oat,1.2,2026-03-02\r\n');
    ctl.showSheet(ctl.sheets[0].id);
    expect(exportCsv(ctl)).toBe('Rent,$900.00\r\nFood,$300.00\r\nTotal,"$1,200.00"\r\n');
  });

  it('a spreadsheet set to a locale with a decimal comma reads, shows and exchanges numbers that way', () => {
    const { ctl, type, get, show } = open();
    ctl.book.setLocale('de-DE');
    type('A1', '1,5');
    type('A2', '1.234,5');
    type('A3', '13.11.2026');
    type('A4', '=SUM(A1:A2)');
    expect(get('A1')).toBe(1.5);
    expect(show('A2')).toBe('1.234,5');
    expect(show('A3')).toBe('13.11.2026');
    expect(show('A4')).toBe('1.236,0');
    ctl.setSelection({ row: 0, col: 0 });
    expect(ctl.barText).toBe('1,5');
    expect(exportCsv(ctl)).toBe('1,5\r\n1.234,5\r\n13.11.2026\r\n1.236,0\r\n');
    // Back to following the reader's browser, which in tests writes numbers as in English.
    ctl.book.setLocale(null);
    expect(show('A2')).toBe('1,234.5');
    expect(show('A3')).toBe('11/13/2026');
    // A file separated by semicolons is read with decimal commas.
    importCsv(ctl, 'Prices.csv', 'Item;Price\r\nTea;2,50\r\nCake;1.234,00\r\n');
    expect(get('B2')).toBe(2.5);
    expect(get('B3')).toBe(1234);
  });

  it('names the selection and goes where a typed name says', () => {
    const { ctl } = open();
    expect(ctl.goToName('c7')).toBe(true);
    expect(ctl.selectionName).toBe('C7');
    expect(ctl.goToName('B2:D4')).toBe(true);
    expect(ctl.selectionName).toBe('B2:D4');
    expect(ctl.goToName('3:5')).toBe(true);
    expect(ctl.selectionName).toBe('3:5');
    expect(ctl.goToName('b:d')).toBe(true);
    expect(ctl.selectionName).toBe('B:D');
    expect(ctl.goToName('ZZ1')).toBe(false);
    expect(ctl.goToName('A5000')).toBe(false);
    expect(ctl.goToName('hello')).toBe(false);
    ctl.selectAll();
    expect(ctl.selectionName).toBe('A1:Z1000');
  });

  it('keeps the selection on its cells when rows are inserted above from elsewhere', () => {
    const { ctl, type, select } = table();
    select('B2');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ctl.book.doc));
    other.getArray<string>('1:rows').insert(0, ['newrow']);
    Y.applyUpdate(ctl.book.doc, Y.encodeStateAsUpdate(other), 'stored');
    expect(ctl.selectionName).toBe('B3');
    type('B3', '$350');
    expect(ctl.engine.textAt(ctl.sheet, 3, 1)).toBe('$1,250.00');
  });
});
