/**
 * Changes to the selected table that act on the cell typed in last: rows
 * and columns beside it, its fill. Each is one step of undo.
 */
import { SLIDE_HEIGHT, type Deck, type SlideElement } from './model';
import { cellKey, cellPlace } from './table';
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

/** Fills the cell typed in last, or every cell of the table when there is none. */
export function fillCells(state: SlidesEditorState, colour: string | null): void {
  const found = target(state);
  if (!found) return;
  const { element, slideId, cell } = found;
  const table = element.table!;
  const cells = cell ? [cell] : table.rows.flatMap(row => table.cols.map(col => cellKey(row.id, col.id)));
  state.step(() => state.deck.setCellFill(slideId, element.id, cells, colour), 'cell-fill');
  state.textEditor?.commands.focus();
}
