import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { Deck, DECK_VERSION } from '../src/lib/slides/model';
import {
  cellKey,
  cellRect,
  edgeBorder,
  insertLine,
  newTable,
  readTable,
  removeLine,
  stepCell,
  tableToJson,
  writeTable,
} from '../src/lib/slides/table';
import { richTextToPlain } from '../src/lib/slides/richTextData';
import { SlidesEditorState } from '../src/lib/slides/editorState.svelte';
import { actingRect, fillCells, pickCells, resizeLine, stretchCells } from '../src/lib/slides/tableEditing';
import { cellChoice, clearPicked, mergeCells, mergePicked, setBorders, setCellBorders, unmergePicked } from '../src/lib/slides/tableCells';

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from), 'remote');
}

function type(fragment: Y.XmlFragment, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  fragment.insert(fragment.length, [paragraph]);
  paragraph.insert(0, [new Y.XmlText(text)]);
}

function tableIn(ydoc: Y.Doc, rows = 3, cols = 3): { deck: Deck; slideId: string; tableId: string; map: () => Y.Map<unknown> } {
  const deck = new Deck(ydoc);
  deck.start('light');
  const slideId = deck.addSlide('blank', []);
  const tableId = deck.addElement(slideId, { type: 'table', x: 100, y: 100, w: 900, h: 300, rot: 0, table: newTable(rows, cols) })!;
  const map = () => (deck.slides.get(slideId)!.get('elements') as Y.Map<Y.Map<unknown>>).get(tableId)!;
  return { deck, slideId, tableId, map };
}

/** The same table in another document, after syncing. */
function tableThere(ydoc: Y.Doc): Y.Map<unknown> {
  const slides = ydoc.getMap('slides') as Y.Map<Y.Map<unknown>>;
  const elements = slides.get([...slides.keys()][0]!)!.get('elements') as Y.Map<Y.Map<unknown>>;
  return elements.get([...elements.keys()][0]!)!;
}

function key(map: Y.Map<unknown>, row: number, col: number): string {
  const table = readTable(map)!;
  return cellKey(table.rows[row]!.id, table.cols[col]!.id);
}

function words(map: Y.Map<unknown>, row: number, col: number): string {
  return richTextToPlain(readTable(map)!.cells.get(key(map, row, col))?.content);
}

describe('merged cells', () => {
  test('merging keeps every word in the top-left cell, hides the others, and raises the format version', () => {
    const { deck, slideId, tableId, map } = tableIn(new Y.Doc());
    type(readTable(map())!.cells.get(key(map(), 0, 0))!.content!, 'Quarter');
    type(readTable(map())!.cells.get(key(map(), 0, 1))!.content!, 'results');
    expect(deck.version).toBe(2);
    deck.transact(() => {
      mergeCells(deck.tableMap(slideId, tableId)!, { r0: 0, r1: 0, c0: 0, c1: 2 });
      deck.requireVersion(3);
    });
    const table = readTable(map())!;
    expect(table.merges.get(key(map(), 0, 0))).toEqual({ rows: 1, cols: 3 });
    expect([...table.covered.keys()]).toEqual([key(map(), 0, 1), key(map(), 0, 2)]);
    expect(words(map(), 0, 0)).toBe('Quarter\nresults');
    expect(words(map(), 0, 1)).toBe('');
    expect(deck.version).toBe(3);
    expect(DECK_VERSION).toBeGreaterThanOrEqual(deck.version);
    // Typing with Tab passes over the hidden cells.
    expect(stepCell(table, key(map(), 0, 0), false)).toBe(key(map(), 1, 0));
  });

  test('a row added inside a merged block on another device joins it; removing a row it spans shrinks it', () => {
    const first = new Y.Doc();
    const { map } = tableIn(first, 3, 2);
    first.transact(() => mergeCells(map(), { r0: 0, r1: 2, c0: 0, c1: 0 }));
    const second = new Y.Doc();
    sync(first, second);
    second.transact(() => insertLine(tableThere(second), 'rows', 1));
    sync(second, first);
    expect(readTable(map())!.merges.get(key(map(), 0, 0))).toEqual({ rows: 4, cols: 1 });
    // Taking away the block's first row moves the block's corner down, keeping the rest merged.
    first.transact(() => removeLine(map(), 'rows', readTable(map())!.rows[0]!.id));
    const table = readTable(map())!;
    expect(table.rows).toHaveLength(3);
    expect(table.merges.get(key(map(), 0, 0))).toEqual({ rows: 3, cols: 1 });
  });

  test('two people merging overlapping cells at once end up with the same table', () => {
    const first = new Y.Doc();
    const { map } = tableIn(first, 3, 3);
    const second = new Y.Doc();
    sync(first, second);
    first.transact(() => mergeCells(map(), { r0: 0, r1: 1, c0: 0, c1: 1 }));
    second.transact(() => mergeCells(tableThere(second), { r0: 1, r1: 2, c0: 1, c1: 2 }));
    sync(first, second);
    sync(second, first);
    const here = readTable(map())!;
    const there = readTable(tableThere(second))!;
    expect([...here.merges]).toEqual([...there.merges]);
    expect(here.merges.size).toBe(1);
    expect(here.merges.get(key(map(), 0, 0))).toEqual({ rows: 2, cols: 2 });
  });

  test('a rectangle picked across a merged block grows to hold all of it', () => {
    const { map } = tableIn(new Y.Doc(), 3, 3);
    mergeCells(map(), { r0: 0, r1: 1, c0: 1, c1: 2 });
    const table = readTable(map())!;
    expect(cellRect(table, key(map(), 1, 0), key(map(), 1, 1))).toEqual({ r0: 0, r1: 1, c0: 0, c1: 2 });
  });

  test('a copied table keeps its merged cells and lines', () => {
    const { map } = tableIn(new Y.Doc(), 2, 2);
    mergeCells(map(), { r0: 0, r1: 0, c0: 0, c1: 1 });
    setCellBorders(map(), { r0: 1, r1: 1, c0: 0, c1: 0 }, 'outer', { width: 3, colour: '#e03131' });
    const copyDoc = new Y.Doc();
    const copy = copyDoc.getMap('copy');
    copyDoc.transact(() => writeTable(copy, JSON.parse(JSON.stringify(tableToJson(readTable(map())!)))));
    const copied = readTable(copy)!;
    expect(copied.merges.size).toBe(1);
    expect(copied.cells.get(key(copy, 1, 0))!.borders).toEqual({ t: { width: 3, colour: '#e03131' }, b: { width: 3, colour: '#e03131' }, l: { width: 3, colour: '#e03131' }, r: { width: 3, colour: '#e03131' } });
  });
});

describe('lines of cells', () => {
  test('a line is written on both cells along an edge, so either side reads it the same', () => {
    const { map } = tableIn(new Y.Doc(), 2, 2);
    setCellBorders(map(), { r0: 0, r1: 0, c0: 0, c1: 0 }, 'bottom', { width: 4, colour: 'accent' });
    const table = readTable(map())!;
    expect(table.cells.get(key(map(), 0, 0))!.borders).toEqual({ b: { width: 4, colour: 'accent' } });
    expect(table.cells.get(key(map(), 1, 0))!.borders).toEqual({ t: { width: 4, colour: 'accent' } });
    const fallback = { width: 1.5, colour: 'muted' };
    expect(edgeBorder(table, key(map(), 0, 0), 'b', key(map(), 1, 0), 't', fallback)).toEqual({ width: 4, colour: 'accent' });
    expect(edgeBorder(table, key(map(), 0, 1), 'b', key(map(), 1, 1), 't', fallback)).toEqual(fallback);
    setCellBorders(map(), { r0: 0, r1: 1, c0: 0, c1: 1 }, 'inner', 'none');
    expect(edgeBorder(readTable(map())!, key(map(), 0, 0), 'b', key(map(), 1, 0), 't', fallback)).toBeNull();
    // The outside keeps the table's line.
    expect(edgeBorder(readTable(map())!, null, 'b', key(map(), 0, 0), 't', fallback)).toEqual(fallback);
    setCellBorders(map(), { r0: 0, r1: 1, c0: 0, c1: 1 }, 'all', null);
    expect([...readTable(map())!.cells.values()].every(cell => !cell.borders)).toBe(true);
  });
});

describe('in the editor', () => {
  function editor(ydoc = new Y.Doc()): SlidesEditorState {
    const state = new SlidesEditorState(ydoc, { addAttachment: async () => 'x.png', canEdit: () => true, deviceId: 'device' });
    state.startDeck();
    state.addSlide('blank');
    state.addTable(3, 3);
    state.stopEditing();
    return state;
  }
  const table = (state: SlidesEditorState) => state.current!.elements.find(element => element.type === 'table')!;
  const cell = (state: SlidesEditorState, row: number, col: number) => cellKey(table(state).table!.rows[row]!.id, table(state).table!.cols[col]!.id);

  test('cells picked by dragging are filled, merged, cleared and unmerged, each a step of undo', () => {
    const state = editor();
    const id = table(state).id;
    state.deck.transact(() => type(table(state).table!.cells.get(cell(state, 1, 1))!.content!, 'Middle'));
    pickCells(state, id, cell(state, 0, 0), cell(state, 1, 1));
    expect(state.pickedCells).toHaveLength(4);
    expect(cellChoice(state)).toEqual({ scope: 'picked', canMerge: true, canUnmerge: false });
    fillCells(state, '#f2c94c');
    expect([0, 1].flatMap(r => [0, 1].map(c => table(state).table!.cells.get(cell(state, r, c))!.fill))).toEqual(Array(4).fill('#f2c94c'));
    expect(table(state).table!.cells.get(cell(state, 2, 2))!.fill).toBeUndefined();
    mergePicked(state);
    expect(table(state).table!.merges.get(cell(state, 0, 0))).toEqual({ rows: 2, cols: 2 });
    expect(richTextToPlain(table(state).table!.cells.get(cell(state, 0, 0))!.content)).toBe('Middle');
    // The merged cell alone can be split again.
    expect(cellChoice(state)).toMatchObject({ scope: 'cell', canUnmerge: true });
    state.undo();
    expect(table(state).table!.merges.size).toBe(0);
    expect(richTextToPlain(table(state).table!.cells.get(cell(state, 1, 1))!.content)).toBe('Middle');
    state.redo();
    expect(table(state).table!.merges.size).toBe(1);
    unmergePicked(state);
    expect(table(state).table!.merges.size).toBe(0);
    pickCells(state, id, cell(state, 0, 0), cell(state, 0, 2));
    expect(clearPicked(state)).toBe(true);
    expect(richTextToPlain(table(state).table!.cells.get(cell(state, 0, 0))!.content)).toBe('');
  });

  test('Shift and the arrows grow the picked cells from the one typed in last', () => {
    const state = editor();
    state.startEditing(table(state).id, { cell: cell(state, 1, 1) });
    state.stopEditing();
    stretchCells(state, 1, 0);
    stretchCells(state, 0, 1);
    expect(state.pickedRect).toEqual({ r0: 1, r1: 2, c0: 1, c1: 2 });
    stretchCells(state, 0, 1);
    expect(state.pickedRect).toEqual({ r0: 1, r1: 2, c0: 1, c1: 2 });
    expect(actingRect(state)).toEqual({ r0: 1, r1: 2, c0: 1, c1: 2 });
    setBorders(state, 'outer', { width: 3, colour: 'accent' });
    expect(table(state).table!.cells.get(cell(state, 1, 1))!.borders).toEqual({ t: { width: 3, colour: 'accent' }, l: { width: 3, colour: 'accent' } });
    expect(table(state).table!.cells.get(cell(state, 0, 1))!.borders).toEqual({ b: { width: 3, colour: 'accent' } });
  });

  test('bold on picked cells touches only their words', () => {
    const state = editor();
    state.deck.transact(() => {
      type(table(state).table!.cells.get(cell(state, 0, 0))!.content!, 'Picked');
      type(table(state).table!.cells.get(cell(state, 2, 2))!.content!, 'Other');
    });
    pickCells(state, table(state).id, cell(state, 0, 0), cell(state, 0, 1));
    state.toggleMark('bold');
    const marked = (row: number, col: number) => (table(state).table!.cells.get(cell(state, row, col))!.content!.toArray()[0] as Y.XmlElement).toArray()
      .flatMap(node => (node as Y.XmlText).toDelta() as Array<{ attributes?: Record<string, unknown> }>)
      .every(part => !!part.attributes?.bold);
    expect(marked(0, 0)).toBe(true);
    expect(marked(2, 2)).toBe(false);
  });

  test('dragging the line between two columns trades width between them; the right edge widens the table', () => {
    const state = editor();
    const element = table(state);
    const [a, b, c] = element.table!.cols;
    const width = element.w;
    resizeLine(state, element.id, 'cols', a!.id, width / 3 + 100, { id: b!.id, length: width / 3 - 100 });
    const lengths = () => {
      const now = table(state);
      const total = now.table!.cols.reduce((sum, col) => sum + col.size, 0);
      return now.table!.cols.map(col => Math.round(now.w * col.size / total));
    };
    expect(lengths()).toEqual([Math.round(width / 3 + 100), Math.round(width / 3 - 100), Math.round(width / 3)]);
    expect(table(state).w).toBe(width);
    resizeLine(state, element.id, 'cols', c!.id, width / 3 + 60);
    expect(table(state).w).toBe(width + 60);
    expect(lengths()).toEqual([Math.round(width / 3 + 100), Math.round(width / 3 - 100), Math.round(width / 3 + 60)]);
    state.undo();
    expect(table(state).w).toBe(width);
  });
});
