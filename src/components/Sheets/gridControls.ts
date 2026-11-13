/**
 * Checkboxes and lists in cells: where a press lands on one, and the menu of
 * a list's choices.
 *
 * The icon names here are only found by the style generator because of this marker:
 * @unocss-include
 */
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { columnX, rowY, type Hit, type Viewport } from '../../lib/sheets/layout';
import { CELL_PAD_X, CHECKBOX, LIST_ARROW, type CellExtras } from '../../lib/sheets/render';
import { chooseFromList, listChoices } from '../../lib/sheets/ruleCommands';
import type { MenuItem } from './PopupMenu.svelte';

/** The checkbox or list arrow a press on a cell lands on, or null. */
export function controlHit(ctl: SheetController, view: Viewport, extras: CellExtras | null, hit: Hit, x: number, y: number): 'checkbox' | 'list' | null {
  if (!extras || hit.area !== 'cell') return null;
  const sheet = ctl.sheet;
  const block = sheet.mergeAt(hit.row, hit.col) ?? { r1: hit.row, c1: hit.col, r2: hit.row, c2: hit.col };
  const control = extras.control(block.r1, block.c1);
  if (!control) return null;
  const left = columnX(view, block.c1);
  const top = rowY(view, block.r1);
  const width = view.cols.end(block.c2) - view.cols.start(block.c1);
  const height = view.rows.end(block.r2) - view.rows.start(block.r1);
  if (control === 'list') return x >= left + width - LIST_ARROW - 4 ? 'list' : null;
  const style = extras.look(block.r1, block.c1);
  const boxLeft = left + (style.a === 'l' ? CELL_PAD_X : style.a === 'r' ? width - CELL_PAD_X - CHECKBOX : (width - CHECKBOX) / 2);
  const boxTop = top + (height - CHECKBOX) / 2;
  // A little room around the box, for a finger.
  const reach = 6;
  return x >= boxLeft - reach && x <= boxLeft + CHECKBOX + reach && y >= boxTop - reach && y <= boxTop + CHECKBOX + reach ? 'checkbox' : null;
}

/** The choices of a cell's list, the one it holds ticked. */
export function listMenu(ctl: SheetController, row: number, col: number): MenuItem[] {
  const choices = listChoices(ctl, row, col) ?? [];
  const current = ctl.engine.textAt(ctl.sheet, row, col).trim().toLowerCase();
  const items: MenuItem[] = choices.map((choice, index) => ({
    label: choice,
    checked: choice.trim().toLowerCase() === current,
    action: () => chooseFromList(ctl, row, col, choice),
    testId: `list-choice-${index}`,
  }));
  if (current) items.push({ label: 'Clear', icon: 'i-lucide-eraser', divider: true, action: () => chooseFromList(ctl, row, col, null), testId: 'list-clear' });
  return items;
}
