/**
 * The actions offered on cells, rows and columns, for the right-click menu and the toolbar.
 *
 * The icon names here are only found by the style generator because of this marker:
 * @unocss-include
 */
import { rectCols, rectContains, rectRows } from '../../lib/sheets/address';
import type { Hit } from '../../lib/sheets/layout';
import {
  autoFitColumn,
  clearContents,
  copySelection,
  deleteSelected,
  fillWithin,
  insertBeside,
  moveSelected,
  pasteText,
} from '../../lib/sheets/commands';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { hiddenNear, hideSelected, showHidden } from '../../lib/sheets/dataCommands';
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

/** Menu entries for the selection. `target` is what was right-clicked or long-pressed; `touch` adds what a keyboard would otherwise do. */
export function selectionMenu(ctl: SheetController, target: 'cell' | 'row' | 'col', touch = false): MenuItem[] {
  const copy: MenuItem = { label: 'Copy', icon: 'i-lucide-copy', hint: `${MOD}C`, action: () => void copyToClipboard(ctl, false), testId: 'menu-copy' };
  if (!ctl.canEdit) return [copy];

  const rect = ctl.selection;
  const rows = rectRows(rect);
  const cols = rectCols(rect);
  const sheet = ctl.sheet;
  const items: MenuItem[] = [];
  if (touch && target === 'cell') {
    items.push({ label: 'Edit cell', icon: 'i-lucide-pencil', action: () => { if (ctl.startEdit()) ctl.focusGrid(); }, testId: 'menu-edit' });
  }
  items.push(
    { label: 'Cut', icon: 'i-lucide-scissors', hint: `${MOD}X`, action: () => void copyToClipboard(ctl, true), testId: 'menu-cut', divider: items.length > 0 },
    copy,
    { label: 'Paste', icon: 'i-lucide-clipboard', hint: `${MOD}V`, action: () => void pasteFromClipboard(ctl), testId: 'menu-paste' },
    { label: 'Paste values only', icon: 'i-lucide-clipboard-type', hint: `${MOD}⇧V`, action: () => void pasteFromClipboard(ctl, true) },
  );
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
      { label: rows === 1 ? 'Hide row' : 'Hide rows', icon: 'i-lucide-eye-off', action: () => hideSelected(ctl, 'row'), divider: true, testId: 'menu-hide-row' },
      ...(hiddenNear(ctl, 'row') ? [{ label: 'Show hidden rows', icon: 'i-lucide-eye', action: () => showHidden(ctl, 'row'), testId: 'menu-show-rows' }] : []),
      { label: 'Fit height to content', icon: 'i-lucide-fold-vertical', action: () => sheet.setRowHeight(rect.r1, rect.r2, null) },
      clear,
    );
  } else if (target === 'col') {
    items.push(
      ...colItems,
      { ...deleteCol, divider: true },
      { label: 'Move left', icon: 'i-lucide-arrow-left', action: () => moveSelected(ctl, 'col', false), disabled: rect.c1 === 0, divider: true, testId: 'menu-move-left' },
      { label: 'Move right', icon: 'i-lucide-arrow-right', action: () => moveSelected(ctl, 'col', true), disabled: rect.c2 >= sheet.cols.length - 1, testId: 'menu-move-right' },
      { label: cols === 1 ? 'Hide column' : 'Hide columns', icon: 'i-lucide-eye-off', action: () => hideSelected(ctl, 'col'), divider: true, testId: 'menu-hide-col' },
      ...(hiddenNear(ctl, 'col') ? [{ label: 'Show hidden columns', icon: 'i-lucide-eye', action: () => showHidden(ctl, 'col'), testId: 'menu-show-cols' }] : []),
      { label: 'Fit width to content', icon: 'i-lucide-fold-horizontal', action: () => autoFitColumn(ctl, rect.c1), testId: 'menu-fit-width' },
      clear,
    );
  } else {
    // Filling copies the first row or column of the selection over the rest, so it needs more than one.
    const fills: MenuItem[] = [
      ...(rows > 1 ? [{ label: 'Fill down', icon: 'i-lucide-arrow-down-from-line', hint: `${MOD}D`, action: () => fillWithin(ctl, 'down'), testId: 'menu-fill-down' }] : []),
      ...(cols > 1 ? [{ label: 'Fill right', icon: 'i-lucide-arrow-right-from-line', hint: `${MOD}R`, action: () => fillWithin(ctl, 'right'), testId: 'menu-fill-right' }] : []),
    ];
    if (fills.length > 0) fills[0].divider = true;
    items.push(
      ...fills,
      ...rowItems,
      ...colItems,
      { ...deleteRow, divider: true },
      deleteCol,
      clear,
    );
  }
  return items;
}

/**
 * Selects what a right click or long press landed on, unless it is part of
 * the selection already, and says what the menu is for.
 */
export function selectForMenu(ctl: SheetController, hit: Hit): 'cell' | 'row' | 'col' {
  const rect = ctl.selection;
  if (hit.area === 'colHeader') {
    if (ctl.scope !== 'cols' || hit.col < rect.c1 || hit.col > rect.c2) ctl.selectCols(hit.col, hit.col);
    return 'col';
  }
  if (hit.area === 'rowHeader') {
    if (ctl.scope !== 'rows' || hit.row < rect.r1 || hit.row > rect.r2) ctl.selectRows(hit.row, hit.row);
    return 'row';
  }
  if (hit.area === 'corner') {
    ctl.selectAll();
    return 'cell';
  }
  if (!rectContains(rect, hit.row, hit.col)) {
    ctl.select({ row: hit.row, col: hit.col });
    return 'cell';
  }
  return ctl.scope === 'rows' ? 'row' : ctl.scope === 'cols' ? 'col' : 'cell';
}
