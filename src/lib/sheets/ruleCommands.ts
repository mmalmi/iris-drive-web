/** Actions on checkboxes, lists and rules, each one undo step. */
import { rectContains } from './address';
import type { SheetController } from './controller.svelte';
import { writeInput } from './edit';
import { addRule, listRules, rangeIds, validationAt, type Check } from './rules';

/** Whether a value counts as a ticked checkbox. */
function isTicked(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === 'string' && value.toLowerCase() === 'true');
}

/**
 * Ticks or unticks checkboxes: the one at a cell, or every checkbox in the
 * selection, all to the opposite of the active cell's.
 */
export function toggleCheckboxes(ctl: SheetController, at?: { row: number; col: number }): boolean {
  if (!ctl.canEdit) return false;
  const sheet = ctl.sheet;
  const start = at ?? ctl.active;
  if (validationAt(sheet, start.row, start.col)?.check.kind !== 'checkbox') return false;
  const next = !isTicked(ctl.engine.valueAt(sheet, start.row, start.col));
  const rect = at ? { r1: at.row, c1: at.col, r2: at.row, c2: at.col } : ctl.selection;
  const checks = listRules(sheet).filter(placed => placed.rule.type === 'valid');
  // The last rule over a cell is the one that counts.
  const isBox = (row: number, col: number) => {
    for (let index = checks.length - 1; index >= 0; index -= 1) {
      const placed = checks[index];
      if (placed.rule.type === 'valid' && rectContains(placed.rect, row, col)) return placed.rule.check.kind === 'checkbox';
    }
    return false;
  };
  const hidden = ctl.visibility;
  ctl.book.transact(() => {
    for (let row = rect.r1; row <= rect.r2; row += 1) {
      if (hidden.rows.has(row)) continue;
      for (let col = rect.c1; col <= rect.c2; col += 1) {
        if (isBox(row, col)) sheet.setRaw(row, col, next);
      }
    }
  });
  return true;
}

/** Puts one of a list's choices into a cell, or empties it with null. */
export function chooseFromList(ctl: SheetController, row: number, col: number, choice: string | null): void {
  if (!ctl.canEdit) return;
  writeInput(ctl.book, ctl.sheet, row, col, choice ?? '');
}

/** The choices a cell offers, or null when it offers none. */
export function listChoices(ctl: SheetController, row: number, col: number): string[] | null {
  const check = validationAt(ctl.sheet, row, col)?.check;
  return check?.kind === 'list' ? check.items : null;
}

/** Adds a validation rule over the selection. Checkboxes start unticked where cells are empty. */
export function addValidation(ctl: SheetController, check: Check, reject: boolean): string | null {
  if (!ctl.canEdit) return null;
  const sheet = ctl.sheet;
  let rect = ctl.selection;
  const used = sheet.usedRect();
  // Whole columns get the rule as far as they are filled, and a little further.
  if (ctl.scope !== 'cells') rect = { ...rect, r2: Math.min(rect.r2, Math.max(rect.r1, (used?.r2 ?? 0) + 20)), c2: Math.min(rect.c2, Math.max(rect.c1, used?.c2 ?? 0)) };
  let id: string | null = null;
  ctl.book.transact(() => {
    id = addRule(sheet, { type: 'valid', range: rangeIds(sheet, rect), check, reject });
    if (check.kind === 'checkbox') {
      for (let row = rect.r1; row <= rect.r2; row += 1) {
        for (let col = rect.c1; col <= rect.c2; col += 1) {
          if (sheet.isEmpty(row, col)) sheet.setRaw(row, col, false);
        }
      }
    }
  });
  return id;
}
