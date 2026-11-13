/**
 * The actions offered on cells, rows and columns, for the right-click menu and the toolbar.
 *
 * The icon names here are only found by the style generator because of this marker:
 * @unocss-include
 */
import { rectCols, rectRows } from '../../lib/sheets/address';
import {
  autoFitColumn,
  clearContents,
  copySelection,
  deleteSelected,
  insertBeside,
  moveSelected,
  pasteText,
} from '../../lib/sheets/commands';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import type { MenuItem } from './PopupMenu.svelte';

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = mac ? '⌘' : 'Ctrl+';

export async function copyToClipboard(ctl: SheetController, cut: boolean): Promise<void> {
  const text = copySelection(ctl, cut);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    ctl.say(`Press ${MOD}${cut ? 'X' : 'C'} to ${cut ? 'cut' : 'copy'}.`);
  }
}

export async function pasteFromClipboard(ctl: SheetController, valuesOnly = false): Promise<void> {
  try {
    pasteText(ctl, await navigator.clipboard.readText(), valuesOnly);
  } catch {
    ctl.say(`Press ${MOD}V to paste.`);
  }
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

/** Menu entries for the selection. `target` is what was right-clicked. */
export function selectionMenu(ctl: SheetController, target: 'cell' | 'row' | 'col'): MenuItem[] {
  const copy: MenuItem = { label: 'Copy', icon: 'i-lucide-copy', hint: `${MOD}C`, action: () => void copyToClipboard(ctl, false), testId: 'menu-copy' };
  if (!ctl.canEdit) return [copy];

  const rect = ctl.selection;
  const rows = rectRows(rect);
  const cols = rectCols(rect);
  const sheet = ctl.sheet;
  const items: MenuItem[] = [
    { label: 'Cut', icon: 'i-lucide-scissors', hint: `${MOD}X`, action: () => void copyToClipboard(ctl, true), testId: 'menu-cut' },
    copy,
    { label: 'Paste', icon: 'i-lucide-clipboard', hint: `${MOD}V`, action: () => void pasteFromClipboard(ctl), testId: 'menu-paste' },
    { label: 'Paste values only', icon: 'i-lucide-clipboard-type', hint: `${MOD}⇧V`, action: () => void pasteFromClipboard(ctl, true) },
  ];
  const rowItems: MenuItem[] = [
    { label: `Insert ${plural(rows, 'row', 'rows')} above`, icon: 'i-lucide-arrow-up-to-line', action: () => insertBeside(ctl, 'row', false), divider: true, testId: 'menu-insert-row-above' },
    { label: `Insert ${plural(rows, 'row', 'rows')} below`, icon: 'i-lucide-arrow-down-to-line', action: () => insertBeside(ctl, 'row', true), testId: 'menu-insert-row-below' },
  ];
  const colItems: MenuItem[] = [
    { label: `Insert ${plural(cols, 'column', 'columns')} left`, icon: 'i-lucide-arrow-left-to-line', action: () => insertBeside(ctl, 'col', false), divider: target !== 'cell', testId: 'menu-insert-col-left' },
    { label: `Insert ${plural(cols, 'column', 'columns')} right`, icon: 'i-lucide-arrow-right-to-line', action: () => insertBeside(ctl, 'col', true), testId: 'menu-insert-col-right' },
  ];
  const deleteRow: MenuItem = { label: `Delete ${plural(rows, 'row', 'rows')}`, icon: 'i-lucide-trash-2', action: () => deleteSelected(ctl, 'row'), disabled: rows >= sheet.rows.length, testId: 'menu-delete-row' };
  const deleteCol: MenuItem = { label: `Delete ${plural(cols, 'column', 'columns')}`, icon: 'i-lucide-trash-2', action: () => deleteSelected(ctl, 'col'), disabled: cols >= sheet.cols.length, testId: 'menu-delete-col' };
  const clear: MenuItem = { label: 'Clear', icon: 'i-lucide-eraser', hint: 'Del', action: () => clearContents(ctl), divider: true, testId: 'menu-clear' };

  if (target === 'row') {
    items.push(
      ...rowItems,
      { ...deleteRow, divider: true },
      { label: 'Move up', icon: 'i-lucide-arrow-up', action: () => moveSelected(ctl, 'row', false), disabled: rect.r1 === 0, divider: true, testId: 'menu-move-up' },
      { label: 'Move down', icon: 'i-lucide-arrow-down', action: () => moveSelected(ctl, 'row', true), disabled: rect.r2 >= sheet.rows.length - 1, testId: 'menu-move-down' },
      { label: 'Fit height to content', icon: 'i-lucide-fold-vertical', action: () => sheet.setRowHeight(rect.r1, rect.r2, null), divider: true },
      clear,
    );
  } else if (target === 'col') {
    items.push(
      ...colItems,
      { ...deleteCol, divider: true },
      { label: 'Move left', icon: 'i-lucide-arrow-left', action: () => moveSelected(ctl, 'col', false), disabled: rect.c1 === 0, divider: true, testId: 'menu-move-left' },
      { label: 'Move right', icon: 'i-lucide-arrow-right', action: () => moveSelected(ctl, 'col', true), disabled: rect.c2 >= sheet.cols.length - 1, testId: 'menu-move-right' },
      { label: 'Fit width to content', icon: 'i-lucide-fold-horizontal', action: () => autoFitColumn(ctl, rect.c1), divider: true, testId: 'menu-fit-width' },
      clear,
    );
  } else {
    items.push(...rowItems, ...colItems, { ...deleteRow, divider: true }, deleteCol, clear);
  }
  return items;
}
