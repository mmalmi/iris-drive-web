/**
 * Changes to the selected table that act on the cells picked, or on the
 * cell typed in last: rows and columns beside it, fills, lines, merging and
 * clearing. Each is one step of undo.
 */
import { SLIDE_HEIGHT, type Deck, type SlideElement } from './model';
import { cellPlace, cellRect, rectKeys, stepCell, type BorderChoice, type CellBorder, type CellRect } from './table';
import type { SlidesEditorState } from './editorState.svelte';

/** The selected table, the cell changes act on, and where that cell is. */
function target(state: SlidesEditorState): { element: SlideElement; slideId: string; cell: string | null; place: { row: number; col: number } | null } | null {
  const element = state.selectedTable;
  if (!state.canEdit || !element?.table || !state.currentId) return null;
  const cell = (state.editingId === element.id ? state.editingCell : null) ?? state.tableCell;
  return { element, slideId: state.currentId, cell, place: cell ? cellPlace(element.table, cell) : null };
}

/** The cell of the selected table that changes act on, when one has been typed in: its key and its own fill. */
export function activeCell(state: SlidesEditorState): { key: string; fill?: string } | null {
  const element = state.selectedTable;
  const key = element ? (state.editingId === element.id ? state.editingCell : null) ?? state.tableCell : null;
  if (!element?.table || !key) return null;
  return { key, fill: element.table.cells.get(key)?.fill };
}

/** Makes a table one row taller, as far as the bottom of the slide allows. */
export function growTable(deck: Deck, slideId: string, element: SlideElement): void {
  const rows = element.table?.rows.length ?? 0;
  if (rows === 0 || element.rot) return;
  const room = SLIDE_HEIGHT - (element.y + element.h);
  const grow = Math.min(Math.round(element.h / rows), Math.max(0, room));
  if (grow > 0) deck.updateElements(slideId, { [element.id]: { h: element.h + grow } });
}

/** Adds a row or column beside the cell typed in last (at the start or the end when there is none). */
export function addTableLine(state: SlidesEditorState, kind: 'row' | 'column', where: 'before' | 'after'): void {
  const found = target(state);
  if (!found) return;
  const { element, slideId, cell, place } = found;
  const lines = kind === 'row' ? element.table!.rows : element.table!.cols;
  const at = place ? (kind === 'row' ? place.row : place.col) : where === 'before' ? 0 : lines.length - 1;
  state.stopEditing();
  state.step(() => state.deck.transact(() => {
    state.deck.insertTableLine(slideId, element.id, kind === 'row' ? 'rows' : 'cols', where === 'before' ? at : at + 1);
    // A new row makes the table taller, as far as the slide has room; a new column shares the width.
    if (kind === 'row') growTable(state.deck, slideId, element);
  }));
  state.tableCell = cell;
}

/** Takes away the row or column of the cell typed in last (the last one when there is none). */
export function removeTableLine(state: SlidesEditorState, kind: 'row' | 'column'): void {
  const found = target(state);
  if (!found) return;
  const { element, slideId, place } = found;
  const lines = kind === 'row' ? element.table!.rows : element.table!.cols;
  const line = place ? lines[kind === 'row' ? place.row : place.col] : lines.at(-1);
  if (!line) return;
  state.stopEditing();
  state.tableCell = null;
  state.step(() => state.deck.removeTableLine(slideId, element.id, kind === 'row' ? 'rows' : 'cols', line.id));
}

/** The cells changes act on: those picked, else the one typed in last (with the rest of its merged block), else every cell. */
export function actingRect(state: SlidesEditorState): CellRect | null {
  const element = state.selectedTable;
  const table = element?.table;
  if (!table) return null;
  if (state.pickedRect && state.pickedCells) return state.pickedRect;
  const cell = (state.editingId === element.id ? state.editingCell : null) ?? state.tableCell;
  if (cell) return cellRect(table, cell, cell);
  return { r0: 0, r1: table.rows.length - 1, c0: 0, c1: table.cols.length - 1 };
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

/** Fills the cells picked, or the one typed in last, or every cell of the table when there is none. */
export function fillCells(state: SlidesEditorState, colour: string | null): void {
  const found = target(state);
  const rect = actingRect(state);
  if (!found || !rect) return;
  const { element, slideId } = found;
  const cells = rectKeys(element.table!, rect);
  state.step(() => state.deck.setCellFill(slideId, element.id, cells, colour), 'cell-fill');
  state.textEditor?.commands.focus();
}

/** Merges the picked cells into one; their words go into it, top-left first. */
export function mergePicked(state: SlidesEditorState): void {
  const found = target(state);
  const rect = state.pickedRect;
  if (!found || !rect || !state.pickedCells) return;
  const anchor = state.step(() => state.deck.mergeTableCells(found.slideId, found.element.id, rect));
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
  state.step(() => state.deck.unmergeTableCells(found.slideId, found.element.id, rect));
}

/** Gives edges of the cells acted on a line of their own, takes them away ('none'), or hands them back to the table (null). */
export function setBorders(state: SlidesEditorState, which: BorderChoice, border: CellBorder | 'none' | null): void {
  const found = target(state);
  const rect = actingRect(state);
  if (!found || !rect) return;
  state.step(() => state.deck.setTableBorders(found.slideId, found.element.id, rect, which, border));
}

/** Takes the words out of the picked cells. */
export function clearPicked(state: SlidesEditorState): boolean {
  const found = target(state);
  const cells = state.pickedCells;
  if (!found || !cells) return false;
  state.step(() => state.deck.clearTableCells(found.slideId, found.element.id, cells));
  return true;
}

/** Stores a row or column's new size in slide units, and the next one's when the line between them was moved. */
export function resizeLine(state: SlidesEditorState, elementId: string, kind: 'rows' | 'cols', id: string, length: number, next?: { id: string; length: number }): void {
  if (!state.canEdit || !state.currentId) return;
  const slideId = state.currentId;
  state.step(() => state.deck.resizeTableLine(slideId, elementId, kind, id, length, next));
}

/**
 * Picks the cells of a table from `anchor` to `focus`, to act on together.
 * Picking a single cell is the same as having typed in it last.
 */
export function pickCells(state: SlidesEditorState, id: string, anchor: string, focus: string): void {
  const element = state.current?.elements.find(candidate => candidate.id === id);
  if (!element?.table || !cellPlace(element.table, anchor) || !cellPlace(element.table, focus)) return;
  if (state.editingId) state.stopEditing();
  if (state.selection.length !== 1 || state.selection[0] !== id) state.selection = [id];
  state.area = 'canvas';
  state.tableCell = anchor;
  state.cellRange = anchor === focus ? null : { id, anchor, focus };
}

/** Grows or shrinks the picked cells by one row or column, from the keyboard. */
export function stretchCells(state: SlidesEditorState, dRow: number, dCol: number): void {
  const element = state.selectedTable;
  const table = element?.table;
  if (!element || !table) return;
  const anchor = state.cellRange?.anchor ?? state.tableCell ?? stepCell(table, '', false);
  if (!anchor) return;
  const from = cellPlace(table, state.cellRange?.focus ?? anchor);
  if (!from) return;
  const row = table.rows[Math.min(table.rows.length - 1, Math.max(0, from.row + dRow))]!;
  const col = table.cols[Math.min(table.cols.length - 1, Math.max(0, from.col + dCol))]!;
  pickCells(state, element.id, anchor, `${row.id}:${col.id}`);
}
