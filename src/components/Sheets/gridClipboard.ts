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
export interface Pasted {
  text: string;
  html: string;
  files: File[];
}

/** What a paste event carries. */
export function pastedFrom(data: DataTransfer | null): Pasted {
  return {
    text: data?.getData('text/plain') ?? '',
    html: data?.getData('text/html') ?? '',
    files: [...(data?.files ?? [])],
  };
}

/** What the clipboard holds, read when a menu asks to paste. */
export async function readClipboard(): Promise<Pasted> {
  const out: Pasted = { text: '', html: '', files: [] };
  for (const item of await navigator.clipboard.read()) {
    for (const type of item.types) {
      const blob = await item.getType(type);
      if (type === 'text/plain') out.text ||= await blob.text();
      else if (type === 'text/html') out.html ||= await blob.text();
      else if (type.startsWith('image/')) out.files.push(new File([blob], `picture.${type.split('/')[1]}`, { type }));
    }
  }
  return out;
}

export function pasteInto(ctl: SheetController, data: Pasted, valuesOnly: boolean): void {
  if (!ctl.canEdit) return;
  const { text, html } = data;
  if (text && ctl.copied?.text === text) {
    pasteText(ctl, text, valuesOnly);
    return;
  }
  if (html && pasteOwnObject(ctl, html)) return;
  const pictures = data.files.filter(file => file.type.startsWith('image/'));
  const table = html && !valuesOnly ? readHtmlTable(html) : null;
  const origin = { row: ctl.selection.r1, col: ctl.selection.c1 };
  if (table && table.cells.length > 0) {
    pasteTable(ctl, table);
    if (table.pictures.length > 0) void pastePictures(ctl, table.pictures, origin);
    return;
  }
  // Text, such as paragraphs from a document, goes into cells; its pictures float beside.
  if (text.trim() !== '') pasteText(ctl, text, valuesOnly);
  if (pictures.length > 0) {
    // The files are the exact pictures; HTML that comes with them only points at them.
    void (async () => {
      for (const [index, picture] of pictures.entries()) await insertPicture(ctl, picture, { ...origin, dx: index * 16, dy: index * 16 });
    })();
  } else if (table && table.pictures.length > 0) {
    void pastePictures(ctl, table.pictures, origin);
  }
}
