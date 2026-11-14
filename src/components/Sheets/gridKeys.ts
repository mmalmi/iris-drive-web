/** What the keyboard does in the grid. */
import { applyStyle, clearContents, clearFormatting, fillWithin, toggleStyle } from '../../lib/sheets/commands';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { serialFromLocalDate } from '../../lib/sheets/dates';
import { NUMBER_FORMATS, editTextOf } from '../../lib/sheets/format';
import { listChoices, toggleCheckboxes } from '../../lib/sheets/ruleCommands';

/** Ctrl+Shift and a digit, as in Google Sheets: number, time, date, currency and percent. */
const FORMAT_KEYS: Record<string, string> = {
  Digit1: NUMBER_FORMATS.number,
  Digit2: NUMBER_FORMATS.time,
  Digit3: NUMBER_FORMATS.date,
  Digit4: NUMBER_FORMATS.dollar,
  Digit5: NUMBER_FORMATS.percent,
};

/** Ctrl+; asks for today's date, Ctrl+Shift+; for the time; null for other keys. */
function nowKey(event: KeyboardEvent): 'date' | 'time' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  // By the key's place where it has one, else by what it writes (on a German keyboard ; is Shift and comma).
  if (event.code === 'Semicolon') return event.shiftKey ? 'time' : 'date';
  return event.key === ';' ? 'date' : event.key === ':' ? 'time' : null;
}

/** Today's date or the time now, written the way it would be typed here. */
function nowText(ctl: SheetController, what: 'date' | 'time'): string {
  const serial = serialFromLocalDate(new Date());
  return what === 'date'
    ? editTextOf(Math.floor(serial), NUMBER_FORMATS.date, ctl.book.numberLocale)
    : editTextOf(serial - Math.floor(serial), NUMBER_FORMATS.time, ctl.book.numberLocale);
}

/** Keys for the list of suggested functions, while it shows. */
export function handleCompletionKey(ctl: SheetController, event: KeyboardEvent): boolean {
  if (!ctl.completion || event.isComposing) return false;
  switch (event.key) {
    case 'ArrowDown': ctl.moveCompletion(1); return true;
    case 'ArrowUp': ctl.moveCompletion(-1); return true;
    case 'Tab':
    case 'Enter': return ctl.acceptCompletion();
    case 'Escape': ctl.closeCompletion(); return true;
    default: return false;
  }
}

/** Keys while a cell is being typed into. Returns true when the key was dealt with. `insert` puts text where the cursor is. */
export function handleEditingKey(ctl: SheetController, event: KeyboardEvent, insert: (text: string) => void): boolean {
  const edit = ctl.edit;
  if (!edit) return false;
  if (handleCompletionKey(ctl, event)) return true;
  const mod = event.ctrlKey || event.metaKey;
  const now = nowKey(event);
  if (now) {
    insert(nowText(ctl, now));
    return true;
  }
  switch (event.key) {
    case 'Enter':
      if (event.isComposing) return false;
      if (event.altKey || mod) insert('\n');
      else ctl.commitEdit(event.shiftKey ? 'up' : 'down');
      return true;
    case 'Tab':
      ctl.commitEdit(event.shiftKey ? 'left' : 'right');
      return true;
    case 'Escape':
      ctl.cancelEdit();
      return true;
    case 'F2':
      ctl.setEditMode(edit.mode === 'enter' ? 'edit' : 'enter');
      return true;
    case 'F4':
      ctl.cycleAbsolute();
      return true;
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      if (edit.mode !== 'enter' || mod || event.altKey) return false;
      const dRow = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      const dCol = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (ctl.pointing) {
        ctl.pointMove(dRow, dCol, event.shiftKey);
      } else {
        ctl.commitEdit();
        ctl.move(dRow, dCol);
      }
      return true;
    }
    default:
      return false;
  }
}

/** Keys while cells are selected and nothing is being typed. */
export function handleGridKey(ctl: SheetController, event: KeyboardEvent, pageRows: number): boolean {
  const mod = event.ctrlKey || event.metaKey;
  const shift = event.shiftKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  switch (key) {
    case 'ArrowUp': ctl.move(-1, 0, { extend: shift, far: mod }); return true;
    case 'ArrowDown':
      if (event.altKey && listChoices(ctl, ctl.active.row, ctl.active.col)) ctl.openList(ctl.active.row, ctl.active.col);
      else ctl.move(1, 0, { extend: shift, far: mod });
      return true;
    case 'ArrowLeft': ctl.move(0, -1, { extend: shift, far: mod }); return true;
    case 'ArrowRight': ctl.move(0, 1, { extend: shift, far: mod }); return true;
    case 'Tab': ctl.step(0, shift ? -1 : 1); return true;
    case 'Enter':
      // On a cell that offers a list, Alt+Enter shows it.
      if (event.altKey && listChoices(ctl, ctl.active.row, ctl.active.col)) ctl.openList(ctl.active.row, ctl.active.col);
      else ctl.step(shift ? -1 : 1, 0);
      return true;
    case 'F2': ctl.startEdit(); return true;
    case 'Delete':
    case 'Backspace': clearContents(ctl); return true;
    case 'Escape':
      if (ctl.commentFor) ctl.commentFor = null;
      else if (ctl.find) ctl.find = null;
      else ctl.copied = null;
      return true;
    case 'Home': ctl.goHome(mod, shift); return true;
    case 'End': ctl.goEnd(mod, shift); return true;
    case 'PageDown': ctl.move(pageRows, 0, { extend: shift }); return true;
    case 'PageUp': ctl.move(-pageRows, 0, { extend: shift }); return true;
    case ' ':
      if (mod) ctl.selectCols(ctl.selection.c1, ctl.selection.c2);
      else if (shift) ctl.selectRows(ctl.selection.r1, ctl.selection.r2);
      // Space ticks a checkbox rather than typing into it.
      else return toggleCheckboxes(ctl);
      return true;
    default:
  }
  // Ctrl+; and Ctrl+Shift+;: today's date or the time, typed in to be confirmed with Enter.
  const now = nowKey(event);
  if (now) {
    ctl.startEdit({ text: nowText(ctl, now) });
    return true;
  }
  const format = mod && shift && !event.altKey ? FORMAT_KEYS[event.code] : undefined;
  if (format) {
    if (ctl.canEdit) applyStyle(ctl, { nf: format });
    return true;
  }
  // Ctrl+Alt+M: a comment on the active cell.
  if (mod && event.altKey && event.code === 'KeyM' && ctl.canEdit) {
    const sheet = ctl.sheet;
    ctl.commentFor = { cell: `${sheet.rows.ids[ctl.active.row]}:${sheet.cols.ids[ctl.active.col]}`, compose: true };
    return true;
  }
  if (!mod || event.altKey) return false;
  switch (key) {
    case 'a': ctl.selectAll(); return true;
    case 'z': if (shift) ctl.redo(); else ctl.undo(); return true;
    case 'y': ctl.redo(); return true;
    case 'b': if (ctl.canEdit) toggleStyle(ctl, 'b'); return true;
    case 'i': if (ctl.canEdit) toggleStyle(ctl, 'i'); return true;
    case 'u': if (ctl.canEdit) toggleStyle(ctl, 'u'); return true;
    case 'x': if (shift && ctl.canEdit) { toggleStyle(ctl, 's'); return true; } return false;
    case 'd': fillWithin(ctl, 'down'); return true;
    case 'r': if (shift) return false; fillWithin(ctl, 'right'); return true;
    case '\\': clearFormatting(ctl); return true;
    case 'l': if (shift && ctl.canEdit) { applyStyle(ctl, { a: 'l' }); return true; } return false;
    case 'e': if (shift && ctl.canEdit) { applyStyle(ctl, { a: 'c' }); return true; } return false;
    default: return false;
  }
}
