import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { Deck, DECK_VERSION, readSlide } from '../src/lib/slides/model';
import { cellKey, ensureCell, insertLine, newTable, readTable, removeLine, setCellFill, stepCell, tableToJson, writeTable } from '../src/lib/slides/table';
import { richTextToPlain } from '../src/lib/slides/richTextData';
import { SlidesEditorState } from '../src/lib/slides/editorState.svelte';
import { addTableLine, removeTableLine } from '../src/lib/slides/tableEditing';

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from), 'remote');
}

function exchange(a: Y.Doc, b: Y.Doc): void {
  sync(a, b);
  sync(b, a);
}

function type(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  fragment.insert(fragment.length, [paragraph]);
  paragraph.insert(0, [new Y.XmlText(text)]);
}

/** A deck with one slide holding one table; returns the table's map. */
function deckWithTable(ydoc: Y.Doc, rows = 2, cols = 2): { deck: Deck; slideId: string; tableId: string; map: () => Y.Map<unknown> } {
  const deck = new Deck(ydoc);
  deck.start('light');
  const slideId = deck.addSlide('blank', []);
  const tableId = deck.addElement(slideId, { type: 'table', x: 100, y: 100, w: 800, h: 300, rot: 0, table: newTable(rows, cols) })!;
  const map = () => (deck.slides.get(slideId)!.get('elements') as Y.Map<Y.Map<unknown>>).get(tableId)!;
  return { deck, slideId, tableId, map };
}

/** The words of every cell, row by row. */
function words(map: Y.Map<unknown>): string[][] {
  const table = readTable(map)!;
  return table.rows.map(row => table.cols.map(col => richTextToPlain(table.cells.get(cellKey(row.id, col.id))?.content)));
}

describe('tables on slides', () => {
  test('a new table has its rows, columns and an empty text for every cell', () => {
    const { deck, slideId, tableId, map } = deckWithTable(new Y.Doc(), 3, 4);
    const element = deck.readSlide(slideId)!.elements.find(candidate => candidate.id === tableId)!;
    expect(element.type).toBe('table');
    expect(element.table!.rows).toHaveLength(3);
    expect(element.table!.cols).toHaveLength(4);
    expect(element.table!.cells.size).toBe(12);
    expect(words(map())).toEqual([['', '', '', ''], ['', '', '', ''], ['', '', '', '']]);
  });

  test('putting a table on a slide marks the deck as needing this version to be edited', () => {
    const ydoc = new Y.Doc();
    const deck = new Deck(ydoc);
    deck.start('light');
    expect(deck.version).toBe(1);
    const slideId = deck.addSlide('blank', []);
    deck.addElement(slideId, { type: 'shape', x: 0, y: 0, w: 10, h: 10, rot: 0 });
    expect(deck.version).toBe(1);
    deck.addElement(slideId, { type: 'table', x: 0, y: 0, w: 10, h: 10, rot: 0, table: newTable(2, 2) });
    expect(deck.version).toBe(2);
    expect(DECK_VERSION).toBeGreaterThanOrEqual(2);
    expect(deck.isNewer).toBe(false);
  });

  test('two people typing in different cells at once both keep their words', () => {
    const first = new Y.Doc();
    const { map } = deckWithTable(first);
    const second = new Y.Doc();
    sync(first, second);
    const there = new Deck(second);
    const otherMap = (there.slides.get([...there.slides.keys()][0]!)!.get('elements') as Y.Map<Y.Map<unknown>>).get([...((there.slides.get([...there.slides.keys()][0]!)!.get('elements') as Y.Map<unknown>).keys())][0]!)!;
    const table = readTable(map())!;
    const otherTable = readTable(otherMap)!;
    type(table.cells.get(cellKey(table.rows[0]!.id, table.cols[0]!.id))!.content!, 'Name');
    type(otherTable.cells.get(cellKey(otherTable.rows[0]!.id, otherTable.cols[1]!.id))!.content!, 'Age');
    exchange(first, second);
    expect(words(map())).toEqual([['Name', 'Age'], ['', '']]);
    expect(words(otherMap)).toEqual(words(map()));
  });

  test('a row and a column added at once on two devices both arrive; the cell where they cross is made when it is typed in', () => {
    const first = new Y.Doc();
    const { map } = deckWithTable(first);
    const second = new Y.Doc();
    sync(first, second);
    const otherSlides = second.getMap('slides') as Y.Map<Y.Map<unknown>>;
    const otherElements = otherSlides.get([...otherSlides.keys()][0]!)!.get('elements') as Y.Map<Y.Map<unknown>>;
    const otherMap = otherElements.get([...otherElements.keys()][0]!)!;
    first.transact(() => insertLine(map(), 'rows', 2));
    second.transact(() => insertLine(otherMap, 'cols', 1));
    exchange(first, second);
    const table = readTable(map())!;
    expect(table.rows).toHaveLength(3);
    expect(table.cols).toHaveLength(3);
    // The new row and the new column each got cells for what was there when they were made.
    expect(table.cells.size).toBe(8);
    const crossing = cellKey(table.rows[2]!.id, table.cols[1]!.id);
    expect(table.cells.has(crossing)).toBe(false);
    first.transact(() => type(ensureCell(map(), crossing)!, 'Here'));
    exchange(first, second);
    expect(words(otherMap)[2]![1]).toBe('Here');
    expect(readTable(otherMap)!.cells.size).toBe(9);
  });

  test('rows and columns go in where asked, and take their cells away with them', () => {
    const { map } = deckWithTable(new Y.Doc(), 2, 2);
    const table = readTable(map())!;
    type(table.cells.get(cellKey(table.rows[0]!.id, table.cols[0]!.id))!.content!, 'A');
    type(table.cells.get(cellKey(table.rows[1]!.id, table.cols[1]!.id))!.content!, 'D');
    const middle = insertLine(map(), 'rows', 1)!;
    expect(readTable(map())!.rows.map(row => row.id)[1]).toBe(middle);
    insertLine(map(), 'cols', 0);
    expect(words(map())).toEqual([['', 'A', ''], ['', '', ''], ['', '', 'D']]);
    removeLine(map(), 'rows', middle);
    expect(words(map())).toEqual([['', 'A', ''], ['', '', 'D']]);
    expect(readTable(map())!.cells.size).toBe(6);
  });

  test('cells keep a fill of their own, and a copy keeps words and fills', () => {
    const { map } = deckWithTable(new Y.Doc(), 2, 3);
    const table = readTable(map())!;
    const corner = cellKey(table.rows[0]!.id, table.cols[0]!.id);
    setCellFill(map(), [corner], '#f2c94c');
    type(table.cells.get(corner)!.content!, 'Total');
    const json = tableToJson(readTable(map())!);
    const copyDoc = new Y.Doc();
    const copy = copyDoc.getMap('copy');
    copyDoc.transact(() => writeTable(copy, JSON.parse(JSON.stringify(json))));
    const copied = readTable(copy)!;
    expect(copied.cells.get(corner)?.fill).toBe('#f2c94c');
    expect(words(copy)).toEqual(words(map()));
    setCellFill(map(), [corner], null);
    expect(readTable(map())!.cells.get(corner)?.fill).toBeUndefined();
  });

  test('stepping through cells goes along a row, then on to the next', () => {
    const { map } = deckWithTable(new Y.Doc(), 2, 2);
    const table = readTable(map())!;
    const [a, b] = table.cols.map(col => cellKey(table.rows[0]!.id, col.id));
    const c = cellKey(table.rows[1]!.id, table.cols[0]!.id);
    expect(stepCell(table, a!, false)).toBe(b);
    expect(stepCell(table, b!, false)).toBe(c);
    expect(stepCell(table, a!, true)).toBeNull();
  });

  test('a table that is not one is read as nothing rather than breaking the slide', () => {
    const ydoc = new Y.Doc();
    const slides = ydoc.getMap('slides') as Y.Map<Y.Map<unknown>>;
    const slide = new Y.Map<unknown>();
    slides.set('s', slide);
    const elements = new Y.Map<unknown>();
    slide.set('elements', elements);
    const broken = new Y.Map<unknown>();
    elements.set('t', broken);
    broken.set('type', 'table');
    broken.set('rows', 'nonsense');
    expect(readSlide('s', slides.get('s'))!.elements).toEqual([]);
  });

  describe('in the editor', () => {
    function editor(): SlidesEditorState {
      const state = new SlidesEditorState(new Y.Doc(), { addAttachment: async () => 'x.png', canEdit: () => true, deviceId: 'device' });
      state.startDeck();
      state.addSlide('blank');
      return state;
    }

    test('a table is put on the slide, its rows and columns are changed, and undo takes each step back', () => {
      const state = editor();
      state.addTable(2, 3);
      const table = () => state.current!.elements.find(element => element.type === 'table')!;
      expect(table().table!.rows).toHaveLength(2);
      expect(table().table!.cols).toHaveLength(3);
      expect(state.selection).toEqual([table().id]);
      addTableLine(state, 'row', 'after');
      expect(table().table!.rows).toHaveLength(3);
      addTableLine(state, 'column', 'before');
      expect(table().table!.cols).toHaveLength(4);
      removeTableLine(state, 'column');
      expect(table().table!.cols).toHaveLength(3);
      state.undo();
      expect(table().table!.cols).toHaveLength(4);
      state.undo();
      state.undo();
      expect(table().table!.rows).toHaveLength(2);
      expect(table().table!.cols).toHaveLength(3);
      state.undo();
      expect(state.current!.elements.some(element => element.type === 'table')).toBe(false);
    });

    test('a duplicated table is a copy with words of its own', () => {
      const state = editor();
      state.addTable(1, 2);
      const original = state.current!.elements.find(element => element.type === 'table')!;
      const first = original.table!.cells.get(cellKey(original.table!.rows[0]!.id, original.table!.cols[0]!.id))!.content!;
      state.deck.transact(() => type(first, 'Mine'));
      state.duplicateSelected();
      const tables = state.current!.elements.filter(element => element.type === 'table');
      expect(tables).toHaveLength(2);
      const copy = tables.find(element => element.id !== original.id)!;
      const copied = copy.table!.cells.get(cellKey(copy.table!.rows[0]!.id, copy.table!.cols[0]!.id))!.content!;
      expect(richTextToPlain(copied)).toBe('Mine');
      expect(copied).not.toBe(first);
    });
  });
});
