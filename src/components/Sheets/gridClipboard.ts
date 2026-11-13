/** Copying cells out of the grid and pasting into it. */
import { copiedHtml, copySelection, pasteText } from '../../lib/sheets/commands';
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { readHtmlTable } from '../../lib/sheets/htmlPaste';
import { insertPicture, pastePictures, pasteTable } from '../../lib/sheets/pasting';
import { copiedObjectHtml, pasteOwnObject } from './objectClipboard';

/** Puts the selection on the clipboard as text and as an HTML table with its pictures. */
export function copyCells(ctl: SheetController, event: ClipboardEvent): void {
  event.clipboardData?.setData('text/plain', copySelection(ctl, event.type === 'cut'));
  event.clipboardData?.setData('text/html', copiedHtml(ctl, copiedObjectHtml(ctl)));
}

/**
 * Our own copy of cells pastes with its formulas; a table from another app
 * or spreadsheet with its looks; a picture floats over the grid. With
 * `valuesOnly` (Shift held), only values are pasted.
 */
export function pasteInto(ctl: SheetController, data: DataTransfer | null, valuesOnly: boolean): void {
  if (!data || !ctl.canEdit) return;
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  if (text && ctl.copied?.text === text) {
    pasteText(ctl, text, valuesOnly);
    return;
  }
  if (html && pasteOwnObject(ctl, html)) return;
  const pictures = [...data.files].filter(file => file.type.startsWith('image/'));
  const table = html && !valuesOnly ? readHtmlTable(html) : null;
  const origin = { row: ctl.selection.r1, col: ctl.selection.c1 };
  if (table && table.cells.length > 0) {
    pasteTable(ctl, table);
    if (table.pictures.length > 0) void pastePictures(ctl, table.pictures, origin);
  } else if (pictures.length > 0) {
    void (async () => {
      for (const [index, picture] of pictures.entries()) await insertPicture(ctl, picture, { ...origin, dx: index * 16, dy: index * 16 });
    })();
  } else if (table && table.pictures.length > 0) {
    void pastePictures(ctl, table.pictures, origin);
  } else {
    pasteText(ctl, text, valuesOnly);
  }
}
