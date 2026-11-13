/**
 * Changes to several cells of a table at once: merging them, splitting them
 * again, giving their edges lines, and emptying them. Each is one step of
 * undo. Loaded with the menus of tables, and when picked cells are emptied.
 */
import * as Y from 'yjs';
import { V3, type Deck } from './model';
import { richTextNodesFromJson, richTextToJson, type RichTextJson } from './richTextData';
import {
  borderValue,
  cellMap,
  cellKey,
  cells,
  ensureCell,
  readTable,
  rectKeys,
  type BorderChoice,
  type CellBorder,
  type CellRect,
  type Side,
} from './table';
import { actingRect } from './tableEditing';

const SIDES: Side[] = ['t', 'b', 'l', 'r'];
import type { SlidesEditorState } from './editorState.svelte';

function isBlank(json: RichTextJson): boolean {
  return json.every(node => ('name' in node ? node.name === 'paragraph' && isBlank(node.children) : node.text.every(part => part.insert === '')));
}

/**
 * Merges the cells of a rectangle into one. The words of every cell go into
 * the top-left one, in reading order, so nothing typed is lost. Returns the
 * key of that cell.
 */
export function mergeCells(map: Y.Map<unknown>, rect: CellRect): string | null {
  const table = readTable(map);
  const cellStore = cells(map);
  if (!table || !cellStore) return null;
  const keys = rectKeys(table, rect);
  if (keys.length < 2) return null;
  const anchorKey = keys[0]!;
  const anchor = ensureCell(map, anchorKey);
  if (!anchor) return null;
  for (const key of keys) {
    const cell = cellStore.get(key);
    if (!cell) continue;
    if (cell.has('merge')) cell.delete('merge');
    if (key === anchorKey) continue;
    const content = cell.get('content');
    if (!(content instanceof Y.XmlFragment) || content.length === 0) continue;
    const words = richTextToJson(content);
    if (!isBlank(words)) {
      // The top-left cell's own empty paragraph makes way for the words.
      if (isBlank(richTextToJson(anchor)) && anchor.length > 0) anchor.delete(0, anchor.length);
      anchor.insert(anchor.length, richTextNodesFromJson(words));
    }
    content.delete(0, content.length);
  }
  cellStore.get(anchorKey)!.set('merge', keys[keys.length - 1]!);
  return anchorKey;
}

/** Splits every merged block that has a cell in the rectangle back into its cells. */
function unmergeCells(map: Y.Map<unknown>, rect: CellRect): void {
  const table = readTable(map);
  const cellStore = cells(map);
  if (!table || !cellStore) return;
  const inside = new Set(rectKeys(table, rect));
  for (const anchor of table.merges.keys()) {
    const hit = inside.has(anchor) || [...table.covered].some(([key, owner]) => owner === anchor && inside.has(key));
    if (hit) cellStore.get(anchor)?.delete('merge');
  }
}

/**
 * Gives edges of the cells in a rectangle a line of their own: a width and
 * colour, 'none' for no line, or null to hand them back to the table's line.
 */
export function setCellBorders(map: Y.Map<unknown>, rect: CellRect, which: BorderChoice, border: CellBorder | 'none' | null): void {
  const table = readTable(map);
  const cellStore = cells(map);
  if (!table || !cellStore) return;
  const value = border ? borderValue(border) : null;
  const write = (r: number, c: number, side: Side) => {
    const row = table.rows[r];
    const col = table.cols[c];
    if (!row || !col) return;
    const key = cellKey(row.id, col.id);
    let cell = cellStore.get(key);
    if (!cell) {
      if (!value) return;
      cell = cellMap(null);
      cellStore.set(key, cell);
    }
    if (value) {
      if (cell.get(`b${side}`) !== value) cell.set(`b${side}`, value);
    } else if (cell.has(`b${side}`)) {
      cell.delete(`b${side}`);
    }
  };
  // Each edge is written on both cells that share it.
  const edge = (r: number, c: number, side: Side) => {
    write(r, c, side);
    if (side === 't') write(r - 1, c, 'b');
    if (side === 'b') write(r + 1, c, 't');
    if (side === 'l') write(r, c - 1, 'r');
    if (side === 'r') write(r, c + 1, 'l');
  };
  for (let r = rect.r0; r <= rect.r1; r += 1) {
    for (let c = rect.c0; c <= rect.c1; c += 1) {
      const sides: Record<Side, boolean> = {
        t: which === 'all' || (r === rect.r0 && (which === 'outer' || which === 'top')) || (r > rect.r0 && which === 'inner'),
        b: which === 'all' || (r === rect.r1 && (which === 'outer' || which === 'bottom')),
        l: which === 'all' || (c === rect.c0 && (which === 'outer' || which === 'left')) || (c > rect.c0 && which === 'inner'),
        r: which === 'all' || (c === rect.c1 && (which === 'outer' || which === 'right')),
      };
      for (const side of SIDES) if (sides[side]) edge(r, c, side);
    }
  }
}

/** Takes the words out of cells, keeping their fill and lines. */
function clearCells(map: Y.Map<unknown>, keys: string[]): void {
  const cellStore = cells(map);
  if (!cellStore) return;
  for (const key of keys) {
    const content = cellStore.get(key)?.get('content');
    if (content instanceof Y.XmlFragment && content.length > 0) content.delete(0, content.length);
  }
}

function mergeTableCells(deck: Deck, slideId: string, elementId: string, rect: CellRect): string | null {
  const map = deck.tableMap(slideId, elementId);
  if (!map) return null;
  return deck.transact(() => {
    const anchor = mergeCells(map, rect);
    if (anchor) deck.requireVersion(V3);
    return anchor;
  });
}

/** The selected table, and the slide it is on, when it may be changed. */
function target(state: SlidesEditorState): { id: string; slideId: string } | null {
  const element = state.selectedTable;
  return state.canEdit && element?.table && state.currentId ? { id: element.id, slideId: state.currentId } : null;
}

/** What the cells being acted on are, for menus: how many, and whether they can be merged or split. */
export function cellChoice(state: SlidesEditorState): { scope: 'picked' | 'cell' | 'all'; canMerge: boolean; canUnmerge: boolean } {
  const element = state.selectedTable;
  const table = element?.table;
  const rect = actingRect(state);
  if (!table || !rect) return { scope: 'all', canMerge: false, canUnmerge: false };
  const picked = !!state.pickedCells;
  const cell = (state.editingId === element.id ? state.editingCell : null) ?? state.tableCell;
  const keys = rectKeys(table, rect);
  const canUnmerge = keys.some(key => table.merges.has(key));
  // Merging a block that is already one merged block would change nothing.
  const oneBlock = keys.length > 1 && table.merges.has(keys[0]!) && keys.slice(1).every(key => table.covered.get(key) === keys[0]);
  return { scope: picked ? 'picked' : cell ? 'cell' : 'all', canMerge: picked && keys.length > 1 && !oneBlock, canUnmerge };
}

/** Merges the picked cells into one; their words go into it, top-left first. */
export function mergePicked(state: SlidesEditorState): void {
  const found = target(state);
  const rect = state.pickedRect;
  if (!found || !rect || !state.pickedCells) return;
  const anchor = state.step(() => mergeTableCells(state.deck, found.slideId, found.id, rect));
  if (anchor) {
    state.cellRange = null;
    state.tableCell = anchor;
  }
}

/** Splits the merged blocks among the cells acted on back into their cells. */
export function unmergePicked(state: SlidesEditorState): void {
  const found = target(state);
  const rect = actingRect(state);
  if (!found || !rect) return;
  state.stopEditing();
  const map = state.deck.tableMap(found.slideId, found.id);
  if (map) state.step(() => state.deck.transact(() => unmergeCells(map, rect)));
}

/** Gives edges of the cells acted on a line of their own, takes them away ('none'), or hands them back to the table (null). */
export function setBorders(state: SlidesEditorState, which: BorderChoice, border: CellBorder | 'none' | null): void {
  const found = target(state);
  const rect = actingRect(state);
  if (!found || !rect) return;
  const map = state.deck.tableMap(found.slideId, found.id);
  if (!map) return;
  state.step(() => state.deck.transact(() => {
    setCellBorders(map, rect, which, border);
    if (border) state.deck.requireVersion(V3);
  }));
}

/** Takes the words out of the picked cells. */
export function clearPicked(state: SlidesEditorState): boolean {
  const found = target(state);
  const cells = state.pickedCells;
  if (!found || !cells) return false;
  const map = state.deck.tableMap(found.slideId, found.id);
  if (!map) return false;
  state.step(() => state.deck.transact(() => clearCells(map, cells)));
  return true;
}
